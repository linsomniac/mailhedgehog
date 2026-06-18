// AIDEV-NOTE: ConfirmDialog tests.
// Verifies confirm fires the callback, cancel doesn't fire confirm.
// jsdom does not support HTMLDialogElement.showModal() natively; we mock it.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom doesn't implement showModal / close on <dialog>; patch the prototype.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = vi.fn();
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = vi.fn();
  }
});

import ConfirmDialog from './ConfirmDialog.svelte';

describe('ConfirmDialog', () => {
  it('renders the title and message', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(ConfirmDialog, {
      props: {
        title: 'Delete everything?',
        message: 'This cannot be undone.',
        onConfirm,
        onCancel,
      },
    });

    expect(screen.getByText('Delete everything?')).toBeTruthy();
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
  });

  it('calls onConfirm when the confirm button is clicked', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(ConfirmDialog, {
      props: {
        title: 'Confirm',
        message: 'Are you sure?',
        onConfirm,
        onCancel,
      },
    });

    const confirmBtn = screen.getByTestId('confirm-ok');
    await fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel when the Cancel button is clicked', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(ConfirmDialog, {
      props: {
        title: 'Confirm',
        message: 'Are you sure?',
        onConfirm,
        onCancel,
      },
    });

    const cancelBtn = screen.getByTestId('confirm-cancel');
    await fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders a custom confirmLabel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(ConfirmDialog, {
      props: {
        title: 'Delete All',
        message: 'Permanently delete all messages?',
        confirmLabel: 'Delete All',
        onConfirm,
        onCancel,
      },
    });

    expect(screen.getByTestId('confirm-ok').textContent?.trim()).toBe('Delete All');
  });

  it('defaults confirmLabel to "Confirm" when not specified', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(ConfirmDialog, {
      props: {
        title: 'Confirm',
        message: 'Sure?',
        onConfirm,
        onCancel,
      },
    });

    expect(screen.getByTestId('confirm-ok').textContent?.trim()).toBe('Confirm');
  });
});
