import PhotometricViewer from './viewer/PhotometricViewer';
import { tv } from './strings';

export default function App() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8 sm:py-10">
      <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-[32px] leading-tight font-medium tracking-[-0.03em] md:text-[48px]">{tv('title')}</h1>
          <p className="mt-2 text-white/60" style={{ lineHeight: 1.7 }}>
            {tv('subtitle')}
          </p>
        </div>
        <p className="text-sm text-white/40 md:max-w-xs md:text-right">{tv('privacy')}</p>
      </header>

      <PhotometricViewer />

      <footer className="mt-16 flex flex-col gap-2 border-t border-white/10 pt-6 text-sm text-white/40 sm:flex-row sm:items-center sm:justify-between">
        <p>Files are parsed in the browser and are not uploaded.</p>
        <p>
          <a
            className="text-white/70 underline decoration-white/20 underline-offset-4 transition-colors hover:text-white"
            href="https://github.com/Taman-Skira/photometric-viewer"
          >
            Source
          </a>
          <span className="px-2 text-white/25">·</span>
          <a
            className="text-white/70 underline decoration-white/20 underline-offset-4 transition-colors hover:text-white"
            href="https://taman.tech"
          >
            Taman
          </a>
        </p>
      </footer>
    </div>
  );
}
