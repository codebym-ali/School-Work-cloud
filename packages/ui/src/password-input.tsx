'use client';

import { useId, useState, type InputHTMLAttributes } from 'react';

/**
 * A password field with a show/hide toggle. Drop-in replacement for `<input type="password">`.
 *
 * **One component, not one per door.** There are four password sign-in surfaces (owner, staff,
 * vendor console, admission portal) and they do not share a form — only this input. Copying a
 * toggle into each is how the same defect gets fixed four times, months apart.
 *
 * ⚠️ **The toggle is `type="button"`.** A `<button>` inside a `<form>` defaults to `type="submit"`,
 * so without this, revealing the password would submit the login form — usually before the user has
 * finished typing it, producing a failed sign-in with no explanation.
 *
 * ⚠️ **Hidden on every mount, deliberately.** The visible state lives in component state and is
 * never persisted: navigating away and back, or reloading, always returns to masked. A remembered
 * "show" setting would eventually reveal a password to whoever is standing behind a school
 * receptionist's desk — and the office counter is exactly where this product is used.
 *
 * The real `<input>` keeps its `id`, `name` and `autoComplete`, so password managers still fill it.
 */
export function PasswordInput({
  toggleLabels = { show: 'Show', hide: 'Hide' },
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  /** Overridable for wording, not for behaviour. */
  toggleLabels?: { show: string; hide: string };
}) {
  const [visible, setVisible] = useState(false);
  const fallbackId = useId();
  const inputId = props.id ?? fallbackId;

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        {...props}
        id={inputId}
        type={visible ? 'text' : 'password'}
        style={{ width: '100%', paddingRight: 64, ...props.style }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        // aria-pressed, not just a label: a screen reader announces the STATE of the toggle, so a
        // user who cannot see the field still knows whether it is currently readable.
        aria-pressed={visible}
        aria-controls={inputId}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: 6,
          // `auto` width and a transparent ground: this sits INSIDE the field, so it must not look
          // or size like the form's submit button.
          width: 'auto',
          padding: '4px 8px',
          margin: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          opacity: 0.7,
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        {visible ? toggleLabels.hide : toggleLabels.show}
      </button>
    </div>
  );
}
