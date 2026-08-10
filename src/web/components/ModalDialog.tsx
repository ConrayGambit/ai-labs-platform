import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalDialogProps {
  labelledBy: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
}

export function ModalDialog({ labelledBy, className = '', children, onClose }: ModalDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    const element = dialog.current;
    const initial = element?.querySelector<HTMLElement>('[data-autofocus]')
      ?? element?.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();
    return () => opener.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialog}
        className={`dialog ${className}`.trim()}
        aria-labelledby={labelledBy}
        aria-modal="true"
        role="dialog"
        onKeyDown={handleKeyDown}
      >
        {children}
      </section>
    </div>
  );
}
