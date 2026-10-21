import { describe, it, expect } from 'vitest';
import { buildForensicSummary } from './pdf';
import type { ForensicReport } from '../types';

describe('buildForensicSummary', () => {
  it('should correctly build a summary from a fully populated report', () => {
    const mockReport: ForensicReport = {
      metadata: {
        author: 'John Doe',
        creator: 'Adobe',
        producer: 'PDFKit',
        pageCount: 5,
      },
      textItems: [],
      annotations: [
        { type: 'Text', subtype: 'FreeText', contents: 'test', page: 1, rect: [0, 0, 10, 10] },
        { type: 'Highlight', subtype: 'Highlight', contents: 'highlight', page: 1, rect: [0, 0, 10, 10] },
      ],
      redactionBoxes: [
        { x: 0, y: 0, width: 10, height: 10, page: 1 },
        { x: 10, y: 10, width: 20, height: 20, page: 2 },
        { x: 30, y: 30, width: 30, height: 30, page: 3 },
      ],
      textUnderRedactions: [
        { text: 'secret', box: { x: 0, y: 0, width: 10, height: 10, page: 1 }, textItem: { str: 'secret', x: 0, y: 0, width: 10, height: 10, fontName: 'Arial', page: 1 }, overlapPercent: 100 },
      ],
      versionInfo: {
        count: 3,
        eofOffsets: [100, 200, 300],
        hasMultipleVersions: true,
      },
      orphanedStrings: ['hidden text', 'deleted text'],
      versionDiffs: [{ missingText: 'earlier text', oldContext: 'earlier text existed', currentContext: 'existed', versionIndex: 0 }],
      plainText: 'some text',
      crossReferences: {
        crossReferences: [],
        namesExtracted: ['John', 'Jane', 'Doe', 'Smith'],
        totalMatches: 2,
        errors: [],
      },
    };

    const summary = buildForensicSummary(mockReport);

    expect(summary).toEqual({
      totalRedactionBoxes: 3,
      textRecoveredFromBoxes: 1,
      annotationsFound: 2,
      versionsDetected: 3,
      versionDiffsFound: 1,
      orphanedStringsFound: 2,
      metadataAvailable: true,
      personsMatched: 2,
      namesExtracted: 4,
    });
  });

  it('should handle an empty/minimal report correctly', () => {
    const mockReport: ForensicReport = {
      metadata: {
        pageCount: 1,
      },
      textItems: [],
      annotations: [],
      redactionBoxes: [],
      textUnderRedactions: [],
      versionInfo: {
        count: 1,
        eofOffsets: [100],
        hasMultipleVersions: false,
      },
      orphanedStrings: [],
      versionDiffs: [],
      plainText: '',
      // crossReferences is undefined by default
    };

    const summary = buildForensicSummary(mockReport);

    expect(summary).toEqual({
      totalRedactionBoxes: 0,
      textRecoveredFromBoxes: 0,
      annotationsFound: 0,
      versionsDetected: 1,
      versionDiffsFound: 0,
      orphanedStringsFound: 0,
      metadataAvailable: false,
      personsMatched: 0,
      namesExtracted: 0,
    });
  });

  it('should evaluate metadataAvailable to true if only one of author, creator, or producer is present', () => {
    const mockReport: ForensicReport = {
      metadata: {
        author: 'Jane Smith',
        pageCount: 1,
      },
      textItems: [],
      annotations: [],
      redactionBoxes: [],
      textUnderRedactions: [],
      versionInfo: {
        count: 1,
        eofOffsets: [100],
        hasMultipleVersions: false,
      },
      orphanedStrings: [],
      versionDiffs: [],
      plainText: '',
    };

    const summary = buildForensicSummary(mockReport);
    expect(summary.metadataAvailable).toBe(true);

    const mockReportCreator: ForensicReport = {
      ...mockReport,
      metadata: { creator: 'CustomTool', pageCount: 1 },
    };
    const summaryCreator = buildForensicSummary(mockReportCreator);
    expect(summaryCreator.metadataAvailable).toBe(true);

    const mockReportProducer: ForensicReport = {
      ...mockReport,
      metadata: { producer: 'CustomProducer', pageCount: 1 },
    };
    const summaryProducer = buildForensicSummary(mockReportProducer);
    expect(summaryProducer.metadataAvailable).toBe(true);
  });
});
