import { ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';
import React, { useState, useRef, useCallback } from 'react';
import ProcessingView from './components/ProcessingView';
import ResultsView from './components/ResultsView';
import Sidebar from './components/Sidebar';
import UploadZone from './components/UploadZone';
import { runForensicExtraction, buildForensicSummary, formatForensicReportForPrompt, fileToBase64 } from './lib/pdf';
import { crossReferencePersons, formatCrossReferencesForPrompt, type CrossReferenceResult } from './lib/personsApi';
import type { ForensicReport, ForensicSummary, HistoryItem, Redaction, Status } from './types';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, MAX_TEXT_LENGTH } from './types';

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState<string>('');
  const [result, setResult] = useState<string>('');
  const [redactions, setRedactions] = useState<Redaction[]>([]);
  const [forensicReport, setForensicReport] = useState<ForensicReport | null>(null);
  const [forensicSummary, setForensicSummary] = useState<ForensicSummary | null>(null);
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [progressStage, setProgressStage] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'reconstructed' | 'raw' | 'forensics'>('reconstructed');
  const [selectedRedaction, setSelectedRedaction] = useState<{
    type: string;
    content: string;
    score: number;
    method?: string;
    explanation?: string;
    alternatives?: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<boolean>(false);

  // Load history from localStorage on mount
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem('pdf-unredactor-history');
      if (saved) {
        const parsed = JSON.parse(saved);
        const migrated = parsed.map((item: any) => ({
          ...item,
          redactions: item.redactions ?? [],
        }));
        setHistory(migrated);
      }
    } catch {
      // Corrupted localStorage — ignore
    }
  }, []);

  const saveToHistory = useCallback(
    (fileName: string, resultText: string, resultRedactions: Redaction[], summary?: ForensicSummary) => {
      const newItem: HistoryItem = {
        id: crypto.randomUUID(),
        fileName,
        result: resultText,
        redactions: resultRedactions,
        forensicSummary: summary,
        timestamp: Date.now(),
      };
      const newHistory = [newItem, ...history];
      setHistory(newHistory);
      try {
        localStorage.setItem('pdf-unredactor-history', JSON.stringify(newHistory));
      } catch {
        // localStorage full — silently fail
      }
    },
    [history]
  );

  const downloadResult = useCallback((resultText: string, fileName: string) => {
    const blob = new Blob([resultText], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace('.pdf', '')}_recovered.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const reset = useCallback(() => {
    setFile(null);
    setRawText('');
    setResult('');
    setRedactions([]);
    setForensicReport(null);
    setForensicSummary(null);
    setError('');
    setStatus('idle');
    setProgress(0);
    setProgressStage('');
    setSelectedRedaction(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const stopProcessing = useCallback(() => {
    cancelRef.current = true;
    reset();
  }, [reset]);

  const handleFileSelect = useCallback(
    async (selectedFile: File) => {
      if (selectedFile.type !== 'application/pdf') {
        setError('Please upload a valid PDF file.');
        setStatus('error');
        return;
      }

      if (selectedFile.size > MAX_FILE_SIZE_BYTES) {
        setError(`File size exceeds ${MAX_FILE_SIZE_MB}MB limit. Please try a smaller PDF.`);
        setStatus('error');
        return;
      }

      cancelRef.current = false;
      setFile(selectedFile);
      setError('');
      setProgress(0);
      setProgressStage('');
      setRedactions([]);
      setForensicReport(null);
      setForensicSummary(null);
      setSelectedRedaction(null);
      setStatus('extracting');

      try {
        // Step 1: Full Forensic Extraction Pipeline
        const arrayBuffer = await selectedFile.arrayBuffer();
        const report = await runForensicExtraction(
          arrayBuffer,
          (p, stage) => {
            setProgress(p);
            setProgressStage(stage);
          },
          () => cancelRef.current
        );

        if (cancelRef.current) return;

        setRawText(report.plainText);
        setForensicReport(report);
        const summary = buildForensicSummary(report);
        setForensicSummary(summary);

        // Build the forensic signals for the AI prompt
        const forensicSignals = formatForensicReportForPrompt(report);

        // Step 2: Cross-reference persons with Epstein Exposed database
        setStatus('cross-referencing');
        setProgressStage('Cross-referencing names against database');

        let crossRefResult: CrossReferenceResult = {
          crossReferences: [], namesExtracted: [], totalMatches: 0, errors: [],
        };
        try {
          crossRefResult = await crossReferencePersons(report.plainText, {
            signal: AbortSignal.timeout(30_000),
          });
          report.crossReferences = crossRefResult;
          setForensicReport({ ...report });
          const updatedSummary = buildForensicSummary(report);
          setForensicSummary(updatedSummary);
        } catch (err) {
          console.warn('Cross-reference lookup failed (non-fatal):', err);
        }

        if (cancelRef.current) return;

        const crossRefSection = crossRefResult.totalMatches > 0
          ? '\n\n' + formatCrossReferencesForPrompt(crossRefResult)
          : '';

        // Truncate plain text if too long
        const truncatedText =
          report.plainText.length > MAX_TEXT_LENGTH
            ? report.plainText.substring(0, MAX_TEXT_LENGTH) + '\n... [Text truncated for processing] ...'
            : report.plainText;

        // Step 3: Enhanced AI Analysis with Forensic Context
        setStatus('analyzing');
        setProgressStage('Sending to AI for analysis');
        const base64 = await fileToBase64(selectedFile);

        if (cancelRef.current) return;

        const prompt = `You are an expert forensic document analyst specializing in PDF redaction recovery. You have been provided with:
1. The PDF file itself (with visual redactions — black boxes)
2. A comprehensive forensic extraction report with multiple layers of evidence

FORENSIC EXTRACTION REPORT:
${forensicSignals}${crossRefSection}

RAW TEXT LAYER:
<raw_text>
${truncatedText}
</raw_text>

YOUR TASK:
Reconstruct the original document as accurately as possible using ALL available forensic signals:

1. **RECOVERED text** — Text found directly under redaction boxes in the text layer. This is the highest-confidence signal. Wrap in [RECOVERED:score]text[/RECOVERED].
2. **INFERRED text** — Text recovered from document version history, orphaned strings, or annotation contents. Wrap in [INFERRED:score]text[/INFERRED].  
3. **GUESSED text** — When no forensic evidence exists, use surrounding context, document topic, formatting patterns, and typical document structures to make an educated guess. Wrap in [GUESSED:score]text[/GUESSED].
4. **CROSS-REFERENCED names** — If a <person_cross_references> section is provided, use the known persons, aliases, and connections to improve guesses about redacted person names.

IMPORTANT RULES:
- The <text_under_redactions> section contains text FOUND DIRECTLY UNDER the black boxes. These are almost certainly the redacted content. Use them with high confidence.
- Cross-reference orphaned strings with the document context to identify which may be remnants of redacted content.
- Consider the document metadata (author, creation software) for context clues.
- Score 0-100 based on evidence strength: text-under-box (85-100), version-history/orphaned (60-85), contextual guess (10-60).
- For each redaction, explain HOW you recovered it (which forensic signal).
- Maintain the original document structure.
- Return the result as JSON.`;

        // Helper for retries with exponential backoff
        const callWithRetry = async (fn: () => Promise<any>, retries = 2) => {
          for (let i = 0; i <= retries; i++) {
            try {
              return await Promise.race([
                fn(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 120_000)),
              ]);
            } catch (err: any) {
              const isNetworkError =
                err.message?.toLowerCase().includes('xhr error') ||
                err.message?.toLowerCase().includes('rpc failed') ||
                err.message?.toLowerCase().includes('fetch');
              if (i === retries || !isNetworkError) throw err;
              console.warn(`Retry ${i + 1} after network error...`);
              await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
            }
          }
        };

        const response = await callWithRetry(async () => {
          const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prompt, base64 }),
          });

          if (!res.ok) {
            let errorMessage = `HTTP error! status: ${res.status}`;
            try {
              const errData = await res.json();
              if (errData.error?.message) {
                errorMessage = errData.error.message;
              }
            } catch {
              // Ignore non-JSON errors
            }
            throw new Error(errorMessage);
          }

          return await res.json();
        });

        if (cancelRef.current) return;

        const resultData = response || {};
        const resultText = resultData.reconstructedText || 'No text could be generated.';
        const resultRedactions: Redaction[] = resultData.redactions || [];

        setResult(resultText);
        setRedactions(resultRedactions);
        saveToHistory(selectedFile.name, resultText, resultRedactions, summary);
        setStatus('done');
      } catch (err: any) {
        if (err.message === 'Cancelled') return;
        console.error('Processing error:', err);

        let errorMessage = 'An unexpected error occurred during processing.';
        if (err.message) {
          errorMessage = err.message;
          try {
            const parsed = JSON.parse(err.message);
            if (parsed.error?.message) {
              errorMessage = parsed.error.message;
            }
          } catch {
            // Not JSON, keep original
          }
        }

        if (err.status === 429 || errorMessage.toLowerCase().includes('quota') || errorMessage.toLowerCase().includes('429')) {
          errorMessage = 'AI API quota exceeded. Please try again later or use a smaller document.';
        } else if (errorMessage.toLowerCase().includes('safety')) {
          errorMessage = 'The document was flagged by AI safety filters and could not be processed.';
        } else if (
          errorMessage.toLowerCase().includes('xhr error') ||
          errorMessage.toLowerCase().includes('rpc failed') ||
          errorMessage.toLowerCase().includes('status code: 6')
        ) {
          errorMessage =
            'Network error. The connection to the AI service failed. Please try a smaller PDF or check your network.';
        } else if (
          errorMessage.toLowerCase().includes('fetch') ||
          errorMessage.toLowerCase().includes('status code: 0') ||
          errorMessage.includes('500 level')
        ) {
          errorMessage =
            'Network error. The connection to the AI service failed. Please check your internet connection and try again.';
        }

        setError(errorMessage);
        setStatus('error');
      }
    },
    [saveToHistory]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0];
      if (selectedFile) {
        handleFileSelect(selectedFile);
      }
    },
    [handleFileSelect]
  );

  const handleHistorySelect = useCallback((item: HistoryItem) => {
    setResult(item.result);
    setRedactions(item.redactions);
    setForensicSummary(item.forensicSummary || null);
    setForensicReport(null); // Full report not stored in history
    setFile({ name: item.fileName } as File);
    setSelectedRedaction(null);
    setActiveTab('reconstructed');
    setStatus('done');
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 font-sans selection:bg-emerald-500/30">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
              <ShieldAlert className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" />
            </div>
            <div>
              <h1 className="font-semibold text-base sm:text-lg tracking-tight">UnRedact</h1>
              <p className="text-[10px] sm:text-xs text-zinc-400 font-medium">Forensic PDF Analysis</p>
            </div>
          </div>
          {status === 'done' && (
            <button onClick={reset} className="text-xs sm:text-sm font-medium text-zinc-400 hover:text-zinc-100 active:text-zinc-100 transition-colors px-2 py-1">
              Start Over
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3 sm:px-6 py-6 sm:py-12">
        {status === 'idle' || status === 'error' ? (
          <UploadZone fileInputRef={fileInputRef} error={error} hasError={status === 'error'} onFileSelect={handleFileSelect} />
        ) : status === 'extracting' || status === 'cross-referencing' || status === 'analyzing' ? (
          <ProcessingView status={status} progress={progress} progressStage={progressStage} onStop={stopProcessing} />
        ) : (
          <div className="flex flex-col lg:grid lg:grid-cols-12 gap-4 sm:gap-8">
            {/* Results first on mobile for better UX */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              className="order-1 lg:order-2 lg:col-span-8"
            >
              <ResultsView
                result={result}
                rawText={rawText}
                redactions={redactions}
                forensicReport={forensicReport}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                selectedRedaction={selectedRedaction}
                setSelectedRedaction={setSelectedRedaction}
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: 'easeOut', delay: 0.15 }}
              className="order-2 lg:order-1 lg:col-span-4"
            >
              <Sidebar
                fileName={file?.name}
                history={history}
                forensicSummary={forensicSummary}
                onDownload={() => downloadResult(result, file?.name || 'document.pdf')}
                onHistorySelect={handleHistorySelect}
              />
            </motion.div>
          </div>
        )}

        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="application/pdf" className="hidden" />
      </main>
    </div>
  );
}
