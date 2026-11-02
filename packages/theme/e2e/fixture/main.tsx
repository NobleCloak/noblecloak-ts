/**
 * The page script of the end-to-end suite, bundled with React into one IIFE by global-setup.ts. It mounts the
 * gallery (or the slot demo) into a fresh element at the end of <body> (or beside the host's own elements)
 * when the test asks.
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { Gallery } from '../../demo/Gallery.js';
import { SlotDemo } from '../../demo/SlotDemo.js';

export interface MountOptions {
  /** 'gallery' (every primitive) or 'slot' (the gallery with Button replaced). */
  readonly demo: 'gallery' | 'slot';
  readonly theme?: 'light' | 'dark';
  /** A class put on the mount element (an ancestor of the root), such as `builder-brand`. */
  readonly wrapperClass?: string;
  readonly dialogOpen?: boolean;
  /** The root's `dir` (left out: inherited, so ltr). */
  readonly dir?: 'ltr' | 'rtl';
  /**
   * The gallery's confirm stays pending until `ncFixture.rejectConfirm` settles it; its errors are recorded in
   * `ncFixture.confirmErrors` (false: the confirm resolves at once).
   */
  readonly pendingConfirm?: boolean;
  /**
   * Put the root itself between the host's two paragraphs in `#nc-host-slot`, rather than in a fresh
   * `#nc-mount` at the end of <body>, so the host has siblings of the root (false).
   */
  readonly besideHost?: boolean;
}

declare global {
  interface Window {
    ncFixture: {
      mount: (options: MountOptions) => void;
      /** Rejects every pending confirm with `message`. */
      rejectConfirm: (message: string) => void;
      /** The messages the confirm dialog reported through onError. */
      confirmErrors: string[];
    };
  }
}

const pending: ((error: Error) => void)[] = [];

window.ncFixture = {
  confirmErrors: [],
  rejectConfirm(message) {
    for (const reject of pending.splice(0)) reject(new Error(message));
  },
  mount(options) {
    const Demo = options.demo === 'slot' ? SlotDemo : Gallery;
    const demo = (
      <Demo
        dialogOpen={options.dialogOpen ?? false}
        {...(options.pendingConfirm === true
          ? {
              onConfirm: () =>
                new Promise<void>((_resolve, reject) => {
                  pending.push(reject);
                }),
              onConfirmError: (error: Error) => {
                window.ncFixture.confirmErrors.push(error.message);
              },
            }
          : {})}
      />
    );
    if (options.besideHost === true) {
      const slot = document.getElementById('nc-host-slot');
      if (slot === null) throw new Error('no #nc-host-slot');
      const root = document.createElement('div');
      root.className = 'nc-root';
      if (options.theme !== undefined) root.setAttribute('data-nc-theme', options.theme);
      if (options.dir !== undefined) root.dir = options.dir;
      slot.insertBefore(root, slot.lastElementChild);
      flushSync(() => {
        createRoot(root).render(demo);
      });
      return;
    }
    const host = document.createElement('div');
    host.id = 'nc-mount';
    if (options.wrapperClass !== undefined) host.className = options.wrapperClass;
    document.body.append(host);
    flushSync(() => {
      createRoot(host).render(
        <div
          className="nc-root"
          {...(options.theme !== undefined ? { 'data-nc-theme': options.theme } : {})}
          {...(options.dir !== undefined ? { dir: options.dir } : {})}
        >
          {demo}
        </div>
      );
    });
  },
};
