import * as pdfjsLib from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type {
  AnnotationInfo,
  DocumentMetadata,
  ForensicReport,
  ForensicSummary,
  RedactionBox,
  TextItem,
  TextUnderRedaction,
  VersionDiff,
} from '../types';
import {
  detectIncrementalSaves,
  diffVersionTexts,
  extractPreviousVersion,
  extractVersionText,
  findOrphanedStrings,
} from './pdfForensics';

// Set the worker source using Vite's ?url import
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Primary forensic extraction pipeline. Runs all analysis layers and returns
 * a structured ForensicReport with every signal we can extract.
 * 
 * Each layer is independently try-caught so a failure in one layer
 * doesn't break the entire pipeline. This is critical for mobile/AI Studio.
 */
export async function runForensicExtraction(
  arrayBuffer: ArrayBuffer,
  onProgress?: (progress: number, stage: string) => void,
  shouldCancel?: () => boolean
): Promise<ForensicReport> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(arrayBuffer);
  } catch {
    data = new Uint8Array(0);
  }

  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const allTextItems: TextItem[] = [];
  const allAnnotations: AnnotationInfo[] = [];
  const allRedactionBoxes: RedactionBox[] = [];
  let plainText = '';

  try {
    const totalSteps = pdf.numPages * 3;
    let completedSteps = 0;

    const reportProgress = (stage: string) => {
      completedSteps++;
      onProgress?.(Math.round((completedSteps / totalSteps) * 90), stage);
    };

    for (let i = 1; i <= pdf.numPages; i++) {
      if (shouldCancel?.()) throw new Error('Cancelled');

      let page: any;
      try {
        page = await pdf.getPage(i);
      } catch (e) {
        console.warn(`Failed to load page ${i}:`, e);
        reportProgress('Extracting text');
        reportProgress('Extracting annotations');
        reportProgress('Detecting redaction boxes');
        continue;
      }

      // --- 1. Positional Text Extraction ---
      try {
        const textContent = await page.getTextContent();
        let pageText = '';

        for (const item of textContent.items) {
          const textItem = item as any;
          if (!textItem.str) continue;

          const tx = textItem.transform;
          if (!tx || tx.length < 6) {
            pageText += textItem.str + ' ';
            continue;
          }

          const x = tx[4];
          const y = tx[5];
          const fontSize = Math.abs(tx[3]) || Math.abs(tx[0]) || 12;
          const width = textItem.width || textItem.str.length * fontSize * 0.5;
          const height = textItem.height || fontSize;

          allTextItems.push({
            str: textItem.str,
            x,
            y,
            width,
            height,
            fontName: textItem.fontName || 'unknown',
            page: i,
          });

          pageText += textItem.str + ' ';
        }

        plainText += `--- Page ${i} ---\n${pageText.trim()}\n\n`;
      } catch (e) {
        console.warn(`Text extraction failed for page ${i}:`, e);
        plainText += `--- Page ${i} ---\n[Text extraction failed]\n\n`;
      }
      reportProgress('Extracting text');

      // --- 2. Annotation Extraction ---
      try {
        const annotations = await page.getAnnotations();
        for (const ann of annotations) {
          allAnnotations.push({
            type: ann.annotationType?.toString() || 'unknown',
            subtype: ann.subtype || 'unknown',
            contents: ann.contents || '',
            page: i,
            rect: ann.rect || [],
            modificationDate: ann.modificationDate,
            color: ann.color,
          });
        }
      } catch {
        // Malformed annotations — skip
      }
      reportProgress('Extracting annotations');

      // --- 3. Redaction Box Detection via Operator List ---
      try {
        const ops = await page.getOperatorList();
        const boxes = detectRedactionBoxesFromOps(ops, i);
        allRedactionBoxes.push(...boxes);
      } catch (e) {
        console.warn(`Operator list failed for page ${i}:`, e);
      }
      reportProgress('Detecting redaction boxes');
    }

    // --- 4. Find text that overlaps with redaction boxes ---
    let textUnderRedactions: TextUnderRedaction[] = [];
    try {
      textUnderRedactions = findTextUnderRedactions(allTextItems, allRedactionBoxes);
    } catch (e) {
      console.warn('Text-under-redaction mapping failed:', e);
    }

    // --- 5. Document Metadata ---
    let metadata: DocumentMetadata = { pageCount: pdf.numPages };
    try {
      metadata = await extractMetadata(pdf);
    } catch (e) {
      console.warn('Metadata extraction failed:', e);
    }

    // --- 6. Binary Analysis (with size guard for mobile) ---
    onProgress?.(88, 'Scanning for hidden versions');
    let versionInfo = { count: 1, eofOffsets: [] as number[], hasMultipleVersions: false };
    let orphanedStrings: string[] = [];
    let versionDiffs: VersionDiff[] = [];

    // Only run binary analysis on files < 5MB to avoid OOM on mobile
    const MAX_BINARY_ANALYSIS_SIZE = 5 * 1024 * 1024;
    if (data.length > 0 && data.length < MAX_BINARY_ANALYSIS_SIZE) {
      try {
        versionInfo = detectIncrementalSaves(data);
      } catch (e) {
        console.warn('Version detection failed:', e);
      }

      // --- 7. Version Text Diffing ---
      if (versionInfo.hasMultipleVersions) {
        onProgress?.(90, 'Comparing document versions');
        try {
          // Extract text from the current (latest) version
          const lastIdx = versionInfo.eofOffsets.length - 1;
          const currentVersionBytes = extractPreviousVersion(data, versionInfo, lastIdx);
          const currentVersionText = currentVersionBytes
            ? await extractVersionText(currentVersionBytes)
            : plainText;

          // Compare each earlier version to the latest
          for (let vi = 0; vi < lastIdx; vi++) {
            if (shouldCancel?.()) throw new Error('Cancelled');
            const prevBytes = extractPreviousVersion(data, versionInfo, vi);
            if (!prevBytes) continue;
            const prevText = await extractVersionText(prevBytes);
            if (!prevText) continue;
            const diffs = diffVersionTexts(prevText, currentVersionText || plainText, vi);
            versionDiffs.push(...diffs);
          }
        } catch (e) {
          if ((e as Error).message === 'Cancelled') throw e;
          console.warn('Version diff analysis failed:', e);
        }
      }

      onProgress?.(95, 'Scanning for orphaned strings');
      try {
        orphanedStrings = findOrphanedStrings(data);
      } catch (e) {
        console.warn('Orphaned string scan failed:', e);
      }
    } else if (data.length >= MAX_BINARY_ANALYSIS_SIZE) {
      console.info('Skipping binary analysis — file too large for mobile');
    }

    onProgress?.(100, 'Extraction complete');

    return {
      metadata: { ...metadata, pageCount: pdf.numPages },
      textItems: allTextItems,
      annotations: allAnnotations,
      redactionBoxes: allRedactionBoxes,
      textUnderRedactions,
      versionInfo,
      versionDiffs,
      orphanedStrings,
      plainText,
    };
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // Already destroyed or failed
    }
  }
}

/**
 * Detects filled black rectangles from a page's operator list.
 * These are the most common form of "redaction" — a black box drawn over text.
 */
function detectRedactionBoxesFromOps(
  ops: any,
  pageNum: number
): RedactionBox[] {
  const boxes: RedactionBox[] = [];

  if (!ops?.fnArray || !ops?.argsArray) return boxes;

  let currentColor = [0, 0, 0];
  let currentPath: number[] = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    try {
      switch (fn) {
        case OPS.setFillRGBColor:
          if (args && args.length >= 3) currentColor = [args[0], args[1], args[2]];
          break;

        case OPS.setFillGray:
          if (args && args.length >= 1) currentColor = [args[0], args[0], args[0]];
          break;

        case OPS.setFillCMYKColor:
          if (args && args.length >= 4) {
            const [c, m, y, k] = args;
            currentColor = [
              (1 - c) * (1 - k),
              (1 - m) * (1 - k),
              (1 - y) * (1 - k),
            ];
          }
          break;

        case OPS.constructPath:
          if (args && args[0] && args[1]) {
            const opCodes = args[0];
            const operands = args[1];
            // OPS.rectangle = 19, but also check by value in case of version differences
            const rectOp = OPS.rectangle ?? 19;
            if (Array.isArray(opCodes) && opCodes.includes(rectOp) && operands.length >= 4) {
              currentPath = [operands[0], operands[1], operands[2], operands[3]];
            }
          }
          break;

        case OPS.fill:
        case OPS.eoFill:
          if (currentPath.length === 4) {
            const isDark = currentColor[0] < 0.15 && currentColor[1] < 0.15 && currentColor[2] < 0.15;
            const [rx, ry, rw, rh] = currentPath;
            const absW = Math.abs(rw);
            const absH = Math.abs(rh);
            if (isDark && absW > 10 && absH > 5) {
              boxes.push({
                x: rx,
                y: ry,
                width: absW,
                height: absH,
                page: pageNum,
              });
            }
          }
          currentPath = [];
          break;
      }
    } catch {
      // Skip malformed operator
      continue;
    }
  }

  return boxes;
}

/**
 * Finds text items whose bounding boxes overlap with redaction boxes.
 */
export function findTextUnderRedactions(
  textItems: TextItem[],
  redactionBoxes: RedactionBox[]
): TextUnderRedaction[] {
  const results: TextUnderRedaction[] = [];

  const textItemsByPage = new Map<number, TextItem[]>();
  for (const text of textItems) {
    const pageTexts = textItemsByPage.get(text.page) || [];
    pageTexts.push(text);
    textItemsByPage.set(text.page, pageTexts);
  }

  for (const box of redactionBoxes) {
    const pageTexts = textItemsByPage.get(box.page) || [];

    for (const text of pageTexts) {
      const overlap = calculateOverlap(
        { x: text.x, y: text.y, w: text.width, h: text.height },
        { x: box.x, y: box.y, w: box.width, h: box.height }
      );

      if (overlap > 0.3) {
        results.push({
          text: text.str,
          box,
          textItem: text,
          overlapPercent: Math.round(overlap * 100),
        });
      }
    }
  }

  return results;
}

/**
 * Calculates the overlap ratio between two rectangles.
 */
function calculateOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const aTop = Math.max(a.y, a.y + a.h);
  const aBottom = Math.min(a.y, a.y + a.h);
  const bTop = Math.max(b.y, b.y + b.h);
  const bBottom = Math.min(b.y, b.y + b.h);

  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(aTop, bTop) - Math.max(aBottom, bBottom));

  const intersectionArea = xOverlap * yOverlap;
  const aArea = Math.abs(a.w * a.h);

  if (aArea === 0) return 0;
  return intersectionArea / aArea;
}

/**
 * Extracts document metadata from the PDF.
 */
async function extractMetadata(pdf: any): Promise<DocumentMetadata> {
  try {
    const metadata = await pdf.getMetadata();
    const info = metadata?.info || {};
    return {
      title: info.Title || undefined,
      author: info.Author || undefined,
      subject: info.Subject || undefined,
      creator: info.Creator || undefined,
      producer: info.Producer || undefined,
      creationDate: info.CreationDate || undefined,
      modificationDate: info.ModDate || undefined,
      keywords: info.Keywords || undefined,
      pageCount: pdf.numPages,
    };
  } catch {
    return { pageCount: pdf.numPages };
  }
}

/**
 * Builds a human-readable forensic summary from a full report.
 */
export function buildForensicSummary(report: ForensicReport): ForensicSummary {
  return {
    totalRedactionBoxes: report.redactionBoxes.length,
    textRecoveredFromBoxes: report.textUnderRedactions.length,
    annotationsFound: report.annotations.length,
    versionsDetected: report.versionInfo.count,
    versionDiffsFound: report.versionDiffs.length,
    orphanedStringsFound: report.orphanedStrings.length,
    metadataAvailable: !!(report.metadata.author || report.metadata.creator || report.metadata.producer),
    personsMatched: report.crossReferences?.totalMatches ?? 0,
    namesExtracted: report.crossReferences?.namesExtracted.length ?? 0,
  };
}

/**
 * Formats the forensic report as a structured text block for the AI prompt.
 */
export function formatForensicReportForPrompt(report: ForensicReport): string {
  const sections: string[] = [];

  // Metadata
  const meta = report.metadata;
  if (meta.author || meta.creator || meta.producer) {
    const metaParts: string[] = [];
    if (meta.author) metaParts.push(`Author: ${meta.author}`);
    if (meta.creator) metaParts.push(`Creator Software: ${meta.creator}`);
    if (meta.producer) metaParts.push(`Producer: ${meta.producer}`);
    if (meta.creationDate) metaParts.push(`Created: ${meta.creationDate}`);
    if (meta.modificationDate) metaParts.push(`Modified: ${meta.modificationDate}`);
    sections.push(`<metadata>\n${metaParts.join('\n')}\n</metadata>`);
  }

  // Version History
  if (report.versionInfo.hasMultipleVersions) {
    sections.push(
      `<version_history>\n${report.versionInfo.count} incremental saves detected. ` +
        `This PDF contains previous versions that may include pre-redaction content.\n</version_history>`
    );
  }

  // Version Diffs — text found in earlier versions but missing from the current one
  if (report.versionDiffs.length > 0) {
    const items = report.versionDiffs.slice(0, 40);
    const lines = items.map(
      (d) =>
        `FROM VERSION ${d.versionIndex}: "${d.missingText}"` +
        (d.oldContext ? `\n  Old context: ...${d.oldContext}...` : '') +
        (d.currentContext ? `\n  Current context: ...${d.currentContext}...` : '')
    );
    sections.push(
      `<version_diffs>\nThese text fragments were present in earlier versions of the PDF but are MISSING from the current version. ` +
        `They were almost certainly removed by redaction and represent HIGH-CONFIDENCE recovered content:\n` +
        `${lines.join('\n\n')}\n</version_diffs>`
    );
  }

  // Redaction Boxes (limit to avoid bloating prompt)
  if (report.redactionBoxes.length > 0) {
    const byPage = new Map<number, RedactionBox[]>();
    for (const box of report.redactionBoxes) {
      const list = byPage.get(box.page) || [];
      list.push(box);
      byPage.set(box.page, list);
    }
    const lines: string[] = [];
    for (const [page, boxes] of byPage) {
      lines.push(`Page ${page}: ${boxes.length} black rectangle(s) detected`);
      for (const box of boxes.slice(0, 20)) {
        lines.push(`  - Box at (${Math.round(box.x)}, ${Math.round(box.y)}), size ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
      if (boxes.length > 20) lines.push(`  ... and ${boxes.length - 20} more`);
    }
    sections.push(`<redaction_boxes>\n${lines.join('\n')}\n</redaction_boxes>`);
  }

  // Text Found Under Redaction Boxes
  if (report.textUnderRedactions.length > 0) {
    const items = report.textUnderRedactions.slice(0, 50);
    const lines = items.map(
      (t) =>
        `Page ${t.textItem.page}: "${t.text}" (${t.overlapPercent}% overlap with redaction box at y=${Math.round(t.box.y)})`
    );
    sections.push(
      `<text_under_redactions>\nThese text fragments were found DIRECTLY UNDER black redaction boxes. ` +
        `They are almost certainly the redacted content:\n${lines.join('\n')}\n</text_under_redactions>`
    );
  }

  // Annotations
  const relevantAnnotations = report.annotations.filter(
    (a) => a.subtype === 'Redact' || a.subtype === 'Highlight' || a.subtype === 'StrikeOut' || a.contents
  );
  if (relevantAnnotations.length > 0) {
    const lines = relevantAnnotations.slice(0, 20).map(
      (a) => `Page ${a.page}: ${a.subtype} annotation${a.contents ? ` — "${a.contents}"` : ''}`
    );
    sections.push(`<annotations>\n${lines.join('\n')}\n</annotations>`);
  }

  // Orphaned Strings (sample)
  if (report.orphanedStrings.length > 0) {
    const sample = report.orphanedStrings.slice(0, 30);
    sections.push(
      `<orphaned_strings>\nThese text strings were found embedded in the raw PDF binary but may not be displayed. ` +
        `Some may be remnants of deleted/redacted content:\n${sample.join('\n')}\n</orphaned_strings>`
    );
  }

  return sections.join('\n\n');
}

// Keep the legacy exports for backward compatibility
export async function extractTextFromPDF(
  arrayBuffer: ArrayBuffer,
  onProgress?: (progress: number) => void,
  shouldCancel?: () => boolean
): Promise<string> {
  const report = await runForensicExtraction(
    arrayBuffer,
    (p) => onProgress?.(p),
    shouldCancel
  );
  return report.plainText;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
}
