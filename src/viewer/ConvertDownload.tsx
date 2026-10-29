import { useState } from 'react';
import { ArrowLeftRight, Download } from 'lucide-react';
import { convertPhotometricText, type ConversionResult, type LoadedPhotometry } from '../photometry';
import { tv } from '../strings';

function saveText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Converts the open file to the other format in the browser and downloads it. */
export default function ConvertDownload({ photometry }: { photometry: LoadedPhotometry }) {
  // Remembers which file the last conversion belongs to, so loading another file clears it.
  const [last, setLast] = useState<{ source: LoadedPhotometry; result?: ConversionResult; error?: string } | null>(null);
  const target = photometry.data.format === 'ies' ? 'ldt' : 'ies';
  const current = last?.source === photometry ? last : null;

  const convert = () => {
    try {
      const result = convertPhotometricText(photometry.text, photometry.data.meta.fileName, target);
      saveText(result.text, result.fileName);
      setLast({ source: photometry, result });
    } catch (e) {
      setLast({ source: photometry, error: (e as Error).message });
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <button
        type="button"
        onClick={convert}
        className="pv-press flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--taman-primary)]/40 bg-[var(--taman-primary)]/10 px-3 py-2 text-xs font-medium text-white transition-[background-color,border-color] duration-200 hover:border-[var(--taman-primary)] hover:bg-[var(--taman-primary)]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--taman-primary)]"
      >
        <ArrowLeftRight className="h-3.5 w-3.5 text-[var(--taman-primary)]" />
        {tv('convert.download', { format: target.toUpperCase() })}
        <Download className="h-3.5 w-3.5 text-white/50" />
      </button>
      <p className="text-center text-[11px] text-white/40">
        {tv('convert.hint', { from: photometry.data.format.toUpperCase(), to: target.toUpperCase() })}
      </p>
      {current?.error && <p className="text-xs text-red-300">{tv('convert.error', { message: current.error })}</p>}
      {current?.result && current.result.warnings.length > 0 && (
        <div className="text-xs text-amber-300/80">
          <p>{tv('convert.warnings', { format: target.toUpperCase() })}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {current.result.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
