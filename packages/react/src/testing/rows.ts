/**
 * Finds a queue row by the id of its approval. A row names the request in words, so it can no longer be told from
 * another by the digest it used to show; the row's button carries the approval id as `data-approval-id`.
 * Not part of the published package.
 */
import { waitFor } from '@testing-library/react';

/** The queue row (a button) of the approval `id`, once it is on the page. */
export function findRowById(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = document.querySelector<HTMLElement>(`button[data-approval-id="${id}"]`);
    if (row === null) throw new Error(`no row for approval ${id}`);
    return row;
  });
}

/** Whether the approval `id` has a row on the page now. */
export function hasRow(id: string): boolean {
  return document.querySelector(`button[data-approval-id="${id}"]`) !== null;
}
