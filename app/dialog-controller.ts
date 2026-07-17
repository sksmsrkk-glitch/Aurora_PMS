"use client";

/** Shared focus trap, Escape handling and scroll locking for PMS dialogs. */

import { useEffect } from "react";

const overlaySelector = ".modal-backdrop, .drawer-backdrop";
const dialogSelector = ".booking-modal, .cashier-modal, .modal.master-modal, .drawer";
const closeSelector = ".drawer-head > button, .modal-head > button";
const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function topOverlay() {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(overlaySelector));
  return overlays[overlays.length - 1] ?? null;
}

function closeTopOverlay() {
  topOverlay()?.querySelector<HTMLButtonElement>(closeSelector)?.click();
}

export function useDialogController() {
  useEffect(() => {
    const enhanceDialogs = () => {
      const overlays = document.querySelectorAll<HTMLElement>(overlaySelector);
      document.body.classList.toggle("dialog-open", overlays.length > 0);

      overlays.forEach((overlay) => {
        const dialog = overlay.querySelector<HTMLElement>(dialogSelector);
        if (!dialog) return;
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("tabindex", "-1");
        if (!dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
          const title = dialog.querySelector<HTMLElement>("h2");
          if (title) {
            if (!title.id) title.id = `dialog-title-${crypto.randomUUID()}`;
            dialog.setAttribute("aria-labelledby", title.id);
          }
        }
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const overlay = topOverlay();
      if (!overlay) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeTopOverlay();
        return;
      }

      if (event.key !== "Tab") return;
      const dialog = overlay.querySelector<HTMLElement>(dialogSelector);
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => element.getClientRects().length > 0,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onBackdropClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches(overlaySelector)) closeTopOverlay();
    };

    const observer = new MutationObserver(enhanceDialogs);
    observer.observe(document.body, { childList: true, subtree: true });
    enhanceDialogs();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onBackdropClick);

    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onBackdropClick);
      document.body.classList.remove("dialog-open");
    };
  }, []);
}
