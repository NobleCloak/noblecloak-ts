/**
 * Every primitive, rendered through the component map in force (`useNcComponents`), so a provider above it
 * replaces what it shows. The preview's stories and the end-to-end pages both render this.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';

import {
  AlertDescription,
  AlertTitle,
  AnnouncerProvider,
  CardContent,
  CardHeader,
  CardTitle,
  useNcComponents,
  VisuallyHidden,
} from '../src/index.js';
import type { DataTableSort } from '../src/index.js';

/** The primitives the gallery shows, one section each, in this order. */
export const GALLERY_SECTIONS = [
  'Button',
  'Input',
  'Label',
  'Textarea',
  'Select',
  'Checkbox',
  'Switch',
  'Tabs',
  'Badge',
  'Alert',
  'Card',
  'Avatar',
  'Tooltip',
  'Separator',
  'Skeleton',
  'Spinner',
  'EmptyState',
  'DataTable',
  'Pagination',
  'Dialog',
] as const;

export type GallerySection = (typeof GALLERY_SECTIONS)[number];

interface Row {
  id: string;
  tool: string;
  level: string;
}

const ROWS: Row[] = [
  { id: 'apr_1', tool: 'ext:billing:refund_customer', level: 'write' },
  { id: 'apr_2', tool: 'ext:crm:delete_contact', level: 'delete' },
  { id: 'apr_3', tool: 'ext:ledger:grant_admin', level: 'admin' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { Card } = useNcComponents();
  return (
    <Card data-section={title} style={{ marginBottom: '1rem' }}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="nc-ui"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}
        >
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export interface GalleryProps {
  /** Which sections to render (all). */
  only?: readonly GallerySection[];
  /** Render the confirm dialog open. */
  dialogOpen?: boolean;
  /** The confirm dialog's onConfirm (does nothing). */
  onConfirm?: () => void | Promise<void>;
  /** The confirm dialog's onError (none). */
  onConfirmError?: (error: Error) => void;
}

export function Gallery({
  only = GALLERY_SECTIONS,
  dialogOpen = false,
  onConfirm = () => undefined,
  onConfirmError,
}: GalleryProps) {
  const c = useNcComponents();
  const [tab, setTab] = useState('pending');
  const [on, setOn] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['apr_2']));
  const [sort, setSort] = useState<DataTableSort | null>({ key: 'tool', direction: 'asc' });
  const [open, setOpen] = useState(dialogOpen);
  const show = (name: GallerySection) => only.includes(name);

  return (
    // The announcer's live regions and a VisuallyHidden render too, so the end-to-end checks cover them.
    <AnnouncerProvider>
      <div className="nc-ui" data-gallery="">
        <VisuallyHidden>Approvals gallery</VisuallyHidden>
        {show('Button') ? (
          <Section title="Button">
            <c.Button>Approve</c.Button>
            <c.Button variant="secondary">Close</c.Button>
            <c.Button variant="ghost">Retry</c.Button>
            <c.Button variant="destructive">Deny</c.Button>
            <c.Button variant="link">Show all</c.Button>
            <c.Button size="sm">Small</c.Button>
            <c.Button size="lg">Large</c.Button>
            <c.Button loading>Approving</c.Button>
            <c.Button disabled>Disabled</c.Button>
          </Section>
        ) : null}
        {show('Input') ? (
          <Section title="Input">
            <c.Input label="Search" placeholder="Tool or request id" />
            <c.Input label="Digest" variant="code" defaultValue="b7e24d90b7e24d90" />
            <c.Input label="Reason" error="A reason is required to deny." />
          </Section>
        ) : null}
        {show('Label') ? (
          <Section title="Label">
            <c.Label htmlFor="gallery-note">Note</c.Label>
            <c.Input id="gallery-note" aria-label="Note" />
          </Section>
        ) : null}
        {show('Textarea') ? (
          <Section title="Textarea">
            <c.Textarea aria-label="Decision reason" placeholder="Why (optional)" />
          </Section>
        ) : null}
        {show('Select') ? (
          <Section title="Select">
            <c.Select
              aria-label="Side-effect level"
              placeholder="Any level"
              options={[
                { value: 'read', label: 'Read' },
                { value: 'write', label: 'Write' },
                { value: 'delete', label: 'Delete' },
              ]}
            />
          </Section>
        ) : null}
        {show('Checkbox') ? (
          <Section title="Checkbox">
            <c.Checkbox aria-label="Select apr_1" defaultChecked />
            <c.Checkbox aria-label="Select apr_2" />
            <c.Checkbox aria-label="Select all" indeterminate />
          </Section>
        ) : null}
        {show('Switch') ? (
          <Section title="Switch">
            <c.Switch aria-label="Live updates" checked={on} onCheckedChange={setOn} />
            <c.Switch aria-label="Sound" />
          </Section>
        ) : null}
        {show('Tabs') ? (
          <Section title="Tabs">
            <c.Tabs
              label="Which approvals"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'pending', label: 'Pending' },
                { value: 'recent', label: 'Recent' },
              ]}
            />
          </Section>
        ) : null}
        {show('Badge') ? (
          <Section title="Badge">
            <c.Badge>read</c.Badge>
            <c.Badge variant="accent">write</c.Badge>
            <c.Badge variant="danger">delete</c.Badge>
            <c.Badge variant="success">approved</c.Badge>
            <c.Badge variant="warning">expiring</c.Badge>
            <c.Badge variant="outline">admin</c.Badge>
          </Section>
        ) : null}
        {show('Alert') ? (
          <Section title="Alert">
            <c.Alert variant="danger">
              <AlertTitle>The approval could not be loaded</AlertTitle>
              <AlertDescription>The service is unavailable. Try again.</AlertDescription>
            </c.Alert>
            <c.Alert variant="success">Approved.</c.Alert>
            <c.Alert variant="warning">This request expires in 2 minutes.</c.Alert>
            <c.Alert>Nothing has changed.</c.Alert>
            <c.Alert variant="danger" solid>
              Session expired.
            </c.Alert>
          </Section>
        ) : null}
        {show('Card') ? (
          <Section title="Card">
            <c.Card>
              <CardContent>A panel inside a panel.</CardContent>
            </c.Card>
          </Section>
        ) : null}
        {show('Avatar') ? (
          <Section title="Avatar">
            <c.Avatar alt="Ana Lima" fallback="AL" />
            <c.Avatar alt="Billing agent" fallback="BA" />
          </Section>
        ) : null}
        {show('Tooltip') ? (
          <Section title="Tooltip">
            <c.Tooltip content="Approves every selected request">
              <c.Button variant="secondary">Approve selected</c.Button>
            </c.Tooltip>
          </Section>
        ) : null}
        {show('Separator') ? (
          <Section title="Separator">
            <span className="nc-ui">Before</span>
            <c.Separator />
            <span className="nc-ui">After</span>
          </Section>
        ) : null}
        {show('Skeleton') ? (
          <Section title="Skeleton">
            <c.Skeleton style={{ width: '12rem' }} />
            <c.Skeleton style={{ width: '6rem' }} />
          </Section>
        ) : null}
        {show('Spinner') ? (
          <Section title="Spinner">
            <c.Spinner size="sm" />
            <c.Spinner />
            <c.Spinner size="lg" label="Loading approvals" />
          </Section>
        ) : null}
        {show('EmptyState') ? (
          <Section title="EmptyState">
            <c.EmptyState
              title="Nothing to review"
              description="New requests appear here as agents ask."
              icon="○"
              action={<c.Button variant="secondary">Refresh</c.Button>}
            />
          </Section>
        ) : null}
        {show('DataTable') ? (
          <Section title="DataTable">
            <c.DataTable
              aria-label="Pending approvals"
              columns={[
                { key: 'tool', header: 'Tool', sortable: true },
                {
                  key: 'level',
                  header: 'Level',
                  render: (row: Row) => <c.Badge>{row.level}</c.Badge>,
                },
              ]}
              data={ROWS}
              rowKey={(row: Row) => row.id}
              sort={sort}
              onSortChange={setSort}
              selectedKeys={selected}
              onSelectionChange={setSelected}
              onRowClick={() => undefined}
            />
          </Section>
        ) : null}
        {show('Pagination') ? (
          <Section title="Pagination">
            <c.Pagination
              hasPrev={false}
              hasNext
              onPrev={() => undefined}
              onNext={() => undefined}
              label="1–20"
            />
          </Section>
        ) : null}
        {show('Dialog') ? (
          <Section title="Dialog">
            <c.Button
              variant="destructive"
              onClick={() => {
                setOpen(true);
              }}
            >
              Deny…
            </c.Button>
            <c.ConfirmDialog
              open={open}
              onOpenChange={setOpen}
              title="Deny the refund?"
              description="The agent is told the request was denied."
              variant="destructive"
              confirmLabel="Deny"
              onConfirm={onConfirm}
              {...(onConfirmError !== undefined ? { onError: onConfirmError } : {})}
            />
          </Section>
        ) : null}
      </div>
    </AnnouncerProvider>
  );
}
