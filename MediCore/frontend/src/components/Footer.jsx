import { HOSPITAL } from '../data/hospitalData';

/** Minimal operational footer (section 2 — secondary information only). */
export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="app-footer">
      <div className="app-footer-inner">
        <p className="app-footer-brand">
          {HOSPITAL.product} <span className="app-footer-sep">·</span> {HOSPITAL.tagline}
        </p>
        <p className="app-footer-note">
          {HOSPITAL.systemNote} <span className="app-footer-sep">·</span> {year}
        </p>
      </div>
    </footer>
  );
}
