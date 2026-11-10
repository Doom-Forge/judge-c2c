import { Link } from 'react-router-dom';

export function Brand() {
  return (
    <Link aria-label="Doomforge workspace overview" className="brand" to="/">
      <span aria-hidden="true" className="brand-mark">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="brand-copy">
        <strong>DOOMFORGE</strong>
        <small>ENGINEERING ARENA</small>
      </span>
    </Link>
  );
}
