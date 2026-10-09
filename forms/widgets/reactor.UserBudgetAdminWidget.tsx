import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.UserBudgetAdminWidget
 *
 * AI usage budget administration as a single custom widget, built on the same
 * pattern as `reactor.UsageDashboardWidget` / `compute_planner.ComputeDashboardWidget`:
 * it owns its state, filters and GraphQL calls, resolves its own React/Material
 * dependencies, and self-registers so the form's `uiSchema` can reference it by FQN.
 *
 * Why a widget rather than the form engine
 * -----------------------------------------
 * This screen is a CRUD console: a filtered table of *all* users is the primary
 * surface, and the budget editor is a detail of a selected row. Driving that
 * through `uiSchema` forced the table's filters, selection and the editor's form
 * state to share one form model, made "save" a page-level submit, and made delete
 * depend on row-selection plumbing (`selected[0].budget.id`). A widget that owns
 * its state removes that whole class of fragility.
 *
 * It runs in two modes, selected by the `scope` prop:
 *
 *   - **admin** (default) — `/admin/ai/budgets`: full console (create/edit/remove,
 *     bulk apply/remove, filters, KPIs, per-user drill-down).
 *   - **self** (`scope: 'self'`) — `/profile/budget`: a read-only view of the
 *     caller's own budget and consumption. It reads `ReactorUserUsageStatus`,
 *     which every authenticated user may call; the admin `…Overview` query (and
 *     the mutations) are admin-gated server-side and are never called here.
 *
 * Server contract (see ReactorAIUsage.graphql / ReactorAIUsage resolvers):
 *   - ReactorUserBudgetOverview(filter) — one row per user, `hasBudget`, month/day
 *     consumption, `status` (`NO_BUDGET` when none).
 *   - ReactorSetUserBudget(input)      — upsert by userId (id *or* email).
 *   - ReactorDeleteUserBudget(id)      — `false` for a no-op, never an error.
 *   - ReactorUserUsageStatus           — the caller's own quota/status + budget.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BudgetDeps {
  React: Reactory.React;
  Material: Reactory.Client.Web.IMaterialModule;
}

interface BudgetWidgetProps {
  reactory: Reactory.Client.IReactoryApi;
  formContext?: any;
  /** `'self'` renders the read-only personal view. */
  scope?: string;
  [key: string]: any;
}

interface BudgetRow {
  userId: string;
  hasBudget: boolean;
  user?: { id?: string; firstName?: string; lastName?: string; email?: string } | null;
  monthlyTokenLimit?: number | null;
  dailyTokenLimit?: number | null;
  monthlyCostLimitUsd?: number | null;
  dailyCostLimitUsd?: number | null;
  currentMonthTokens?: number | null;
  currentMonthCostUsd?: number | null;
  currentDayTokens?: number | null;
  currentDayCostUsd?: number | null;
  alertThresholdPercent?: number | null;
  hardStop?: boolean | null;
  notes?: string | null;
  status?: string | null;
  budget?: { id?: string; updatedAt?: string } | null;
}

interface BudgetForm {
  userId: string;
  monthlyTokenLimit: string;
  dailyTokenLimit: string;
  monthlyCostLimitUsd: string;
  dailyCostLimitUsd: string;
  alertThresholdPercent: string;
  hardStop: boolean;
  notes: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

const OVERVIEW_QUERY = `query ReactorUserBudgetOverview($filter: ReactorBudgetOverviewFilterInput) {
  ReactorUserBudgetOverview(filter: $filter) {
    userId
    hasBudget
    monthlyTokenLimit
    dailyTokenLimit
    monthlyCostLimitUsd
    dailyCostLimitUsd
    alertThresholdPercent
    hardStop
    notes
    currentMonthTokens
    currentMonthCostUsd
    currentDayTokens
    currentDayCostUsd
    status
    user { id firstName lastName email }
    budget { id userId status updatedAt }
  }
}`;

const SET_BUDGET_MUTATION = `mutation ReactorSetUserBudget($input: ReactorSetUserBudgetInput!) {
  ReactorSetUserBudget(input: $input) {
    id
    userId
    monthlyTokenLimit
    dailyTokenLimit
    monthlyCostLimitUsd
    dailyCostLimitUsd
    alertThresholdPercent
    hardStop
    status
    notes
  }
}`;

const DELETE_BUDGET_MUTATION = `mutation ReactorDeleteUserBudget($id: String!) {
  ReactorDeleteUserBudget(id: $id)
}`;

const SET_BUDGETS_BULK_MUTATION = `mutation ReactorSetUserBudgetsBulk($input: ReactorSetUserBudgetsBulkInput!) {
  ReactorSetUserBudgetsBulk(input: $input) {
    requested
    applied
    created
    updated
    deleted
    skipped
    failed
    errors { userId message }
  }
}`;

const DELETE_BUDGETS_BULK_MUTATION = `mutation ReactorDeleteUserBudgetsBulk($userIds: [String!]!) {
  ReactorDeleteUserBudgetsBulk(userIds: $userIds) {
    requested
    applied
    created
    updated
    deleted
    skipped
    failed
    errors { userId message }
  }
}`;

interface BulkBudgetResult {
  requested: number;
  applied: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  errors: Array<{ userId: string; message: string }>;
}

/** A one-line, honest summary of a bulk result — including partial failure. */
const summariseBulk = (label: string, r: BulkBudgetResult): string => {
  const parts = [`${label} ${toNumber(r.applied)}`];
  if (toNumber(r.created) || toNumber(r.updated)) {
    parts.push(`(${toNumber(r.created)} created, ${toNumber(r.updated)} updated)`);
  }
  if (toNumber(r.skipped)) parts.push(`${toNumber(r.skipped)} skipped`);
  if (toNumber(r.failed)) parts.push(`${toNumber(r.failed)} failed`);
  return parts.join(' · ');
};

const USER_STATUS_QUERY = `query ReactorUserUsageStatus {
  ReactorUserUsageStatus {
    allowed
    status
    percentageUsed
    reason
    budget {
      monthlyTokenLimit
      dailyTokenLimit
      monthlyCostLimitUsd
      dailyCostLimitUsd
      currentMonthTokens
      currentMonthCostUsd
      currentDayTokens
      currentDayCostUsd
      alertThresholdPercent
      hardStop
      status
    }
  }
}`;

/**
 * The overview resolver caps results (default 500, max 2000). The console fetches
 * once at the cap and filters client-side so the table and the editor's user
 * picker share one data source and filtering is instant. Directories larger than
 * this need server-side search/paging — flagged rather than silently truncated.
 */
const OVERVIEW_LIMIT = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const fmtInt = (value: unknown): string => toNumber(value).toLocaleString();

const fmtUsd = (value: unknown, decimals = 2): string => `$${toNumber(value).toFixed(decimals)}`;

const pct = (part: unknown, whole: unknown): number => {
  const w = toNumber(whole);
  if (w <= 0) return 0;
  return Math.round((toNumber(part) / w) * 100);
};

const userLabel = (row: BudgetRow | null | undefined): string => {
  if (!row) return '—';
  const name = [row.user?.firstName, row.user?.lastName].filter(Boolean).join(' ').trim();
  return row.user?.email || name || row.userId || '—';
};

const statusMeta = (status: unknown): { label: string; color: 'success' | 'warning' | 'error' | 'default' | 'info' } => {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE':
      return { label: 'Active', color: 'success' };
    case 'WARNING':
      return { label: 'Warning', color: 'warning' };
    case 'EXCEEDED':
      return { label: 'Exceeded', color: 'error' };
    case 'DISABLED':
      return { label: 'Disabled', color: 'default' };
    case 'NO_BUDGET':
      return { label: 'No budget', color: 'default' };
    default:
      return { label: String(status || '—'), color: 'default' };
  }
};

/** A ratio bar that turns amber at the warn threshold and red once exceeded. */
const ratioColor = (used: unknown, limit: unknown, threshold: unknown): 'success' | 'warning' | 'error' => {
  const l = toNumber(limit);
  if (l <= 0) return 'success';
  const usePct = (toNumber(used) / l) * 100;
  const warn = toNumber(threshold) || 80;
  if (usePct >= 100) return 'error';
  if (usePct >= warn) return 'warning';
  return 'success';
};

const emptyForm = (): BudgetForm => ({
  userId: '',
  monthlyTokenLimit: '',
  dailyTokenLimit: '',
  monthlyCostLimitUsd: '',
  dailyCostLimitUsd: '',
  alertThresholdPercent: '80',
  hardStop: false,
  notes: '',
});

const rowToForm = (row: BudgetRow): BudgetForm => ({
  userId: row.userId,
  monthlyTokenLimit: row.monthlyTokenLimit != null ? String(row.monthlyTokenLimit) : '',
  dailyTokenLimit: row.dailyTokenLimit != null ? String(row.dailyTokenLimit) : '',
  monthlyCostLimitUsd: row.monthlyCostLimitUsd != null ? String(row.monthlyCostLimitUsd) : '',
  dailyCostLimitUsd: row.dailyCostLimitUsd != null ? String(row.dailyCostLimitUsd) : '',
  alertThresholdPercent:
    row.alertThresholdPercent != null ? String(row.alertThresholdPercent) : '80',
  hardStop: Boolean(row.hardStop),
  notes: row.notes != null ? String(row.notes) : '',
});

/**
 * Build the mutation input from the editor form.
 *
 * `blankMeansUnlimited` matters and differs by mode, because the server only
 * writes fields it receives (`if (value !== undefined)`) and treats an explicit
 * `null` as "unlimited":
 *
 *   - single edit (true)  — every field is prefilled from the row, so a blank is
 *     a deliberate clear. It is sent as `null` so "clear the limit" actually means
 *     unlimited, rather than being silently ignored and leaving the old limit in
 *     place.
 *   - bulk (false)        — the form starts blank and is applied to many users,
 *     so a blank must mean "leave this limit alone"; sending `null` would wipe the
 *     limits of every selected user.
 */
const formToInput = (
  form: BudgetForm,
  userId: string,
  blankMeansUnlimited: boolean,
): Record<string, unknown> => {
  const input: Record<string, unknown> = { userId };

  /** A blank limit: `null` (unlimited) in edit mode, omitted (unchanged) in bulk. */
  const setLimit = (key: string, raw: string, round: boolean) => {
    const trimmed = String(raw ?? '').trim();
    const parsed = trimmed ? Number(trimmed) : NaN;
    if (!Number.isFinite(parsed)) {
      if (blankMeansUnlimited) input[key] = null;
      return;
    }
    input[key] = round ? Math.round(parsed) : parsed;
  };

  setLimit('monthlyTokenLimit', form.monthlyTokenLimit, true);
  setLimit('dailyTokenLimit', form.dailyTokenLimit, true);
  setLimit('monthlyCostLimitUsd', form.monthlyCostLimitUsd, false);
  setLimit('dailyCostLimitUsd', form.dailyCostLimitUsd, false);

  // The warn threshold is a non-null column with a server default, so it is only
  // written when actually supplied — never cleared.
  const threshold = Number(String(form.alertThresholdPercent ?? '').trim());
  if (Number.isFinite(threshold)) input.alertThresholdPercent = Math.round(threshold);

  // `hardStop` and `notes` are always written: they are not "leave unchanged"
  // fields, and the editor always presents their current value.
  input.hardStop = Boolean(form.hardStop);
  input.notes = form.notes || null;

  return input;
};

// ─────────────────────────────────────────────────────────────────────────────
// Presentational building blocks (module scope — stable component identity)
// ─────────────────────────────────────────────────────────────────────────────

const Kpi = (props: { R: any; M: any; label: string; value: string; icon: string; accent: string; sub?: string }) => {
  const { R, M, label, value, icon, accent, sub } = props;
  const { Paper, Box, Typography, Icon } = M;
  return R.createElement(
    Paper,
    {
      elevation: 0,
      variant: 'outlined',
      sx: {
        p: 2,
        height: '100%',
        borderRadius: '14px',
        borderTop: `4px solid ${accent}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
    },
    R.createElement(
      Box,
      { sx: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      R.createElement(
        Typography,
        { variant: 'caption', color: 'text.secondary', sx: { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' } },
        label,
      ),
      R.createElement(Icon, { sx: { fontSize: 18, color: accent } }, icon),
    ),
    R.createElement(Typography, { variant: 'h6', sx: { fontWeight: 700, fontFamily: 'monospace', color: accent } }, value),
    sub ? R.createElement(Typography, { variant: 'caption', color: 'text.secondary' }, sub) : null,
  );
};

const BudgetProgress = (props: {
  R: any;
  M: any;
  label: string;
  used: unknown;
  limit: unknown;
  threshold: unknown;
  format: (v: unknown) => string;
}) => {
  const { R, M, label, used, limit, threshold, format } = props;
  const { Box, Typography, LinearProgress } = M;
  const hasLimit = toNumber(limit) > 0;
  const value = hasLimit ? Math.min(pct(used, limit), 100) : 0;
  return R.createElement(
    Box,
    null,
    R.createElement(
      Box,
      { sx: { display: 'flex', justifyContent: 'space-between', mb: 0.25, gap: 1 } },
      R.createElement(Typography, { variant: 'caption', color: 'text.secondary' }, label),
      R.createElement(
        Typography,
        { variant: 'caption', sx: { fontFamily: 'monospace' } },
        hasLimit ? `${format(used)} / ${format(limit)}` : `${format(used)} / Unlimited`,
      ),
    ),
    R.createElement(LinearProgress, {
      variant: 'determinate',
      value,
      color: hasLimit ? ratioColor(used, limit, threshold) : 'inherit',
      sx: { height: 6, borderRadius: 3 },
    }),
  );
};

const ConfirmDialog = (props: {
  R: any;
  M: any;
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const { R, M, open, title, message, confirmLabel, busy, onCancel, onConfirm } = props;
  const { Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button, CircularProgress } = M;
  return R.createElement(
    Dialog,
    { open, onClose: busy ? undefined : onCancel, maxWidth: 'xs', fullWidth: true },
    R.createElement(DialogTitle, null, title),
    R.createElement(DialogContent, null, R.createElement(DialogContentText, null, message)),
    R.createElement(
      DialogActions,
      null,
      R.createElement(Button, { onClick: onCancel, disabled: busy }, 'Cancel'),
      R.createElement(
        Button,
        { onClick: onConfirm, color: 'error', variant: 'contained', disabled: busy, startIcon: busy ? R.createElement(CircularProgress, { size: 16 }) : null },
        confirmLabel || 'Confirm',
      ),
    ),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Widget
// ─────────────────────────────────────────────────────────────────────────────

const UserBudgetAdminWidget = (props: BudgetWidgetProps) => {
  const { reactory, formContext } = props;

  const { React, Material } = reactory.getComponents<BudgetDeps>(['react.React', 'material-ui.Material']);

  const MaterialCore = (Material && Material.MaterialCore) || {};
  const {
    Box, Typography, Grid, Paper, Divider, Button, Icon, Chip, Alert, TextField, MenuItem,
    Autocomplete, LinearProgress, CircularProgress, Dialog, DialogTitle, DialogContent,
    DialogActions, Checkbox, Tooltip, Table, TableHead, TableBody, TableRow, TableCell,
    TableContainer, FormControlLabel, Switch, IconButton,
  } = MaterialCore;

  // ── Mode ───────────────────────────────────────────────────────────────────
  const contextProps = (formContext && (formContext.props || (formContext.$ref && formContext.$ref.props))) || {};
  const scope = String(props.scope || contextProps.scope || '');
  const isSelf = scope === 'self';

  /**
   * Navigate within the SPA.
   *
   * The SDK exposes react-router's `NavigateFunction` as **`reactory.navigation`**
   * (assigned in `ReactoryRouter`). `reactory.history` is declared on the API but
   * is initialised to `null` and never assigned, so navigating through it silently
   * does nothing — which is exactly how the budget screen's drill-down failed to
   * open the usage dashboard.
   */
  const navigate = (path: string) => {
    try {
      const api: any = reactory as any;
      if (typeof api?.navigation === 'function') {
        api.navigation(path);
        return;
      }
      const win: any = typeof window !== 'undefined' ? window : null;
      if (typeof win?.reactory?.api?.navigation === 'function') {
        win.reactory.api.navigation(path);
        return;
      }
      // Last resorts, for a host that predates `navigation`.
      if (api?.history?.push) {
        api.history.push(path);
        return;
      }
      if (win?.reactory?.api?.history?.push) {
        win.reactory.api.history.push(path);
        return;
      }
      if (win?.history?.pushState) {
        win.history.pushState({}, '', path);
        win.dispatchEvent(new PopStateEvent('popstate'));
      }
    } catch {
      // navigation is a convenience; never throw from it
    }
  };

  // ── Shared state ───────────────────────────────────────────────────────────
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // ── Admin state ────────────────────────────────────────────────────────────
  const [rows, setRows] = React.useState<BudgetRow[]>([]);
  const [search, setSearch] = React.useState<string>('');
  const [budgetFilter, setBudgetFilter] = React.useState<'all' | 'budgeted' | 'unbudgeted'>('all');
  const [selected, setSelected] = React.useState<{ [userId: string]: boolean }>({});

  const [editorOpen, setEditorOpen] = React.useState<boolean>(false);
  const [editorMode, setEditorMode] = React.useState<'single' | 'bulk'>('single');
  const [editorForm, setEditorForm] = React.useState<BudgetForm>(emptyForm);
  const [saving, setSaving] = React.useState<boolean>(false);

  const [confirm, setConfirm] = React.useState<
    | { kind: 'delete'; row: BudgetRow }
    | { kind: 'bulk-delete'; userIds: string[] }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = React.useState<boolean>(false);

  // ── Self state ─────────────────────────────────────────────────────────────
  const [status, setStatus] = React.useState<any>(null);

  const unwrap = (settled: any, key: string): { data: any; error: string | null } => {
    if (!settled || settled.status !== 'fulfilled') {
      const reason = settled && settled.reason;
      return { data: null, error: reason?.message ? String(reason.message) : 'Request failed' };
    }
    const value = settled.value;
    const data = value && value.data ? value.data : value;
    const errors = value && value.errors;
    if (errors && errors.length) {
      return { data, error: errors.map((e: any) => e.message).filter(Boolean).join('; ') || 'GraphQL error' };
    }
    return { data: data ? data[key] : null, error: null };
  };

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchAdmin = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const settled = await Promise.allSettled([
      (reactory as any).graphqlQuery(OVERVIEW_QUERY, { filter: { limit: OVERVIEW_LIMIT } }),
    ]);
    const out = unwrap(settled[0], 'ReactorUserBudgetOverview');
    setRows(Array.isArray(out.data) ? out.data : []);
    setError(out.error);
    setLoading(false);
  }, [reactory]);

  const fetchSelf = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const settled = await Promise.allSettled([
      (reactory as any).graphqlQuery(USER_STATUS_QUERY, {}),
    ]);
    const out = unwrap(settled[0], 'ReactorUserUsageStatus');
    setStatus(out.data || null);
    setError(out.error);
    setLoading(false);
  }, [reactory]);

  const refetch = React.useCallback(() => (isSelf ? fetchSelf() : fetchAdmin()), [isSelf, fetchAdmin, fetchSelf]);

  React.useEffect(() => {
    refetch();
  }, [refetch]);

  React.useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  // ── Derived (admin) ────────────────────────────────────────────────────────
  const filtered: BudgetRow[] = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (budgetFilter === 'budgeted' && !row.hasBudget) return false;
      if (budgetFilter === 'unbudgeted' && row.hasBudget) return false;
      if (!needle) return true;
      const haystack = [
        row.user?.firstName, row.user?.lastName, row.user?.email, row.userId,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, search, budgetFilter]);

  const kpis = React.useMemo(() => {
    const budgeted = rows.filter((r) => r.hasBudget).length;
    const overThreshold = rows.filter((r) => ['WARNING', 'EXCEEDED'].includes(String(r.status || '').toUpperCase())).length;
    const hardStop = rows.filter((r) => r.hasBudget && r.hardStop).length;
    return { total: rows.length, budgeted, unbudgeted: rows.length - budgeted, overThreshold, hardStop };
  }, [rows]);

  const selectedUserIds = React.useMemo(
    () => Object.keys(selected).filter((id) => selected[id]),
    [selected],
  );
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected[r.userId]);

  const userOptions = React.useMemo(
    () => rows.map((row) => ({ value: row.userId, label: userLabel(row), hasBudget: row.hasBudget })),
    [rows],
  );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveSingle = async (): Promise<boolean> => {
    if (!editorForm.userId) {
      setError('Select a user before saving a budget.');
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const settled = await Promise.allSettled([
        (reactory as any).graphqlMutation(SET_BUDGET_MUTATION, {
          input: formToInput(editorForm, editorForm.userId, true),
        }),
      ]);
      const out = unwrap(settled[0], 'ReactorSetUserBudget');
      if (out.error) throw new Error(out.error);
      setNotice(`Budget saved for ${userLabel(rows.find((r) => r.userId === editorForm.userId)) || editorForm.userId}.`);
      setEditorOpen(false);
      await fetchAdmin();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Failed to save budget.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveBulk = async (): Promise<boolean> => {
    const targets = selectedUserIds;
    if (targets.length === 0) return false;
    setSaving(true);
    setError(null);
    try {
      // One request for the whole selection — the server applies it as a single
      // bulkWrite and returns the created/updated/skipped/failed breakdown.
      const patch = formToInput(editorForm, '', false);
      delete (patch as any).userId;

      const settled = await Promise.allSettled([
        (reactory as any).graphqlMutation(SET_BUDGETS_BULK_MUTATION, {
          input: { userIds: targets, ...patch },
        }),
      ]);
      const out = unwrap(settled[0], 'ReactorSetUserBudgetsBulk');
      if (out.error) throw new Error(out.error);

      const result = out.data as BulkBudgetResult;
      const summary = summariseBulk('Applied to', result);
      if (toNumber(result.failed)) {
        setError(`${summary}. ${result.errors.slice(0, 3).map((e) => `${e.userId}: ${e.message}`).join('; ')}`);
      } else {
        setNotice(`${summary}.`);
      }
      setEditorOpen(false);
      setSelected({});
      await fetchAdmin();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Bulk apply failed.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeBudget = async (row: BudgetRow) => {
    const id = row.budget?.id;
    if (!id) {
      setError('That user has no budget to remove.');
      return;
    }
    setConfirmBusy(true);
    try {
      const settled = await Promise.allSettled([
        (reactory as any).graphqlMutation(DELETE_BUDGET_MUTATION, { id }),
      ]);
      const out = unwrap(settled[0], 'ReactorDeleteUserBudget');
      if (out.error) throw new Error(out.error);
      setNotice(`Budget removed for ${userLabel(row)}.`);
      setConfirm(null);
      await fetchAdmin();
    } catch (err: any) {
      setError(err?.message || 'Failed to remove budget.');
    } finally {
      setConfirmBusy(false);
    }
  };

  const removeBulk = async (userIds: string[]) => {
    setConfirmBusy(true);
    setError(null);
    try {
      // Delete is keyed on user ids: the selection is users, and one without a
      // budget is `skipped` on the server, never an error.
      const settled = await Promise.allSettled([
        (reactory as any).graphqlMutation(DELETE_BUDGETS_BULK_MUTATION, { userIds }),
      ]);
      const out = unwrap(settled[0], 'ReactorDeleteUserBudgetsBulk');
      if (out.error) throw new Error(out.error);

      const result = out.data as BulkBudgetResult;
      const summary = summariseBulk('Removed', result);
      if (toNumber(result.failed)) {
        setError(`${summary}. ${result.errors.slice(0, 3).map((e) => `${e.userId}: ${e.message}`).join('; ')}`);
      } else {
        setNotice(`${summary}.`);
      }
      setConfirm(null);
      setSelected({});
      await fetchAdmin();
    } catch (err: any) {
      setError(err?.message || 'Bulk remove failed.');
    } finally {
      setConfirmBusy(false);
    }
  };

  // ── Editor helpers ─────────────────────────────────────────────────────────
  const openNew = () => {
    setEditorMode('single');
    setEditorForm(emptyForm());
    setEditorOpen(true);
  };
  const openEdit = (row: BudgetRow) => {
    setEditorMode('single');
    setEditorForm(rowToForm(row));
    setEditorOpen(true);
  };
  const openBulk = () => {
    if (selectedUserIds.length === 0) return;
    setEditorMode('bulk');
    setEditorForm({ ...emptyForm(), userId: '' });
    setEditorOpen(true);
  };
  const setField = (key: keyof BudgetForm, value: any) =>
    setEditorForm((prev) => ({ ...prev, [key]: value }));

  // ── Render: header ─────────────────────────────────────────────────────────
  const header = R_createHeader(React, MaterialCore, { isSelf, onRefresh: refetch, loading });

  // ── Render: self mode ──────────────────────────────────────────────────────
  if (isSelf) {
    const budget = status?.budget || null;
    return React.createElement(
      Box,
      { sx: { p: { xs: 2, md: 3 }, bgcolor: 'background.default', minHeight: '100vh' } },
      header,
      loading ? React.createElement(LinearProgress, { sx: { mb: 2, borderRadius: 1 } }) : null,
      error ? React.createElement(Alert, { severity: 'error', sx: { mb: 2 }, onClose: () => setError(null) }, error) : null,
      !loading && !budget
        ? React.createElement(
            Alert,
            { severity: 'info', sx: { mb: 2 } },
            'No AI budget is configured for your account. Your usage is still tracked on the usage dashboard.',
          )
        : null,
      budget
        ? React.createElement(
            Grid,
            { container: true, spacing: 2 },
            React.createElement(
              Grid,
              { item: true, xs: 12, sm: 6, md: 3 },
              React.createElement(Kpi, {
                R: React, M: MaterialCore, label: 'Quota Status',
                value: String(status?.status || '—'), icon: 'verified_user',
                accent: status?.allowed === false ? '#ef4444' : '#22c55e',
                sub: status?.reason ? String(status.reason) : (status?.allowed === false ? 'Turns are blocked' : 'Turns allowed'),
              }),
            ),
            React.createElement(
              Grid,
              { item: true, xs: 12, sm: 6, md: 3 },
              React.createElement(Kpi, {
                R: React, M: MaterialCore, label: 'Used',
                value: `${toNumber(status?.percentageUsed)}%`, icon: 'speed',
                accent: '#38bdf8', sub: 'of current limits',
              }),
            ),
            React.createElement(
              Grid,
              { item: true, xs: 12, sm: 6, md: 3 },
              React.createElement(Kpi, {
                R: React, M: MaterialCore, label: 'Hard Stop',
                value: budget.hardStop ? 'On' : 'Off', icon: 'gpp_maybe',
                accent: budget.hardStop ? '#f97316' : '#94a3b8',
                sub: budget.hardStop ? 'Turns blocked once exceeded' : 'Warn only',
              }),
            ),
            React.createElement(
              Grid,
              { item: true, xs: 12, sm: 6, md: 3 },
              React.createElement(Kpi, {
                R: React, M: MaterialCore, label: 'Warn Threshold',
                value: `${toNumber(budget.alertThresholdPercent) || 80}%`, icon: 'notifications_active',
                accent: '#fbbf24', sub: 'Warning level',
              }),
            ),
            React.createElement(
              Grid,
              { item: true, xs: 12, md: 6 },
              React.createElement(
                Paper,
                { variant: 'outlined', sx: { p: 2.5, borderRadius: '14px', height: '100%' } },
                React.createElement(Typography, { variant: 'h6', sx: { fontWeight: 600, mb: 2 } }, 'This month'),
                React.createElement(
                  Box,
                  { sx: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  React.createElement(BudgetProgress, {
                    R: React, M: MaterialCore, label: 'Tokens',
                    used: budget.currentMonthTokens, limit: budget.monthlyTokenLimit,
                    threshold: budget.alertThresholdPercent, format: fmtInt,
                  }),
                  React.createElement(BudgetProgress, {
                    R: React, M: MaterialCore, label: 'Spend (USD)',
                    used: budget.currentMonthCostUsd, limit: budget.monthlyCostLimitUsd,
                    threshold: budget.alertThresholdPercent, format: (v: unknown) => fmtUsd(v, 4),
                  }),
                ),
              ),
            ),
            React.createElement(
              Grid,
              { item: true, xs: 12, md: 6 },
              React.createElement(
                Paper,
                { variant: 'outlined', sx: { p: 2.5, borderRadius: '14px', height: '100%' } },
                React.createElement(Typography, { variant: 'h6', sx: { fontWeight: 600, mb: 2 } }, 'Today'),
                React.createElement(
                  Box,
                  { sx: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  React.createElement(BudgetProgress, {
                    R: React, M: MaterialCore, label: 'Tokens',
                    used: budget.currentDayTokens, limit: budget.dailyTokenLimit,
                    threshold: budget.alertThresholdPercent, format: fmtInt,
                  }),
                  React.createElement(BudgetProgress, {
                    R: React, M: MaterialCore, label: 'Spend (USD)',
                    used: budget.currentDayCostUsd, limit: budget.dailyCostLimitUsd,
                    threshold: budget.alertThresholdPercent, format: (v: unknown) => fmtUsd(v, 4),
                  }),
                ),
              ),
            ),
          )
        : null,
      R_createFooter(React, MaterialCore, () =>
        navigate('/profile/usage'),
      ),
    );
  }

  // ── Render: admin mode ─────────────────────────────────────────────────────
  const columns: Array<{
    title: string;
    render: (row: BudgetRow) => any;
    align?: 'left' | 'right' | 'center';
    sx?: any;
  }> = [
    {
      title: 'User',
      render: (row) =>
        React.createElement(
          Box,
          null,
          React.createElement(Typography, { variant: 'body2', sx: { fontWeight: 600 } }, userLabel(row)),
          React.createElement(
            Typography,
            { variant: 'caption', color: 'text.secondary', sx: { fontFamily: 'monospace' } },
            row.budget?.id || row.userId,
          ),
        ),
    },
    {
      title: 'Budget',
      render: (row) =>
        row.hasBudget
          ? React.createElement(Chip, { size: 'small', color: 'primary', variant: 'outlined', label: 'Configured' })
          : React.createElement(Chip, { size: 'small', variant: 'outlined', label: 'None' }),
    },
    {
      title: 'Status',
      render: (row) => {
        const meta = statusMeta(row.status);
        return React.createElement(Chip, {
          size: 'small',
          color: meta.color,
          variant: meta.color === 'default' ? 'outlined' : 'filled',
          label: meta.label,
        });
      },
    },
    {
      title: 'Month Tokens',
      sx: { minWidth: 190 },
      render: (row) =>
        React.createElement(BudgetProgress, {
          R: React, M: MaterialCore, label: '', used: row.currentMonthTokens,
          limit: row.monthlyTokenLimit, threshold: row.alertThresholdPercent, format: fmtInt,
        }),
    },
    {
      title: 'Month Spend',
      sx: { minWidth: 190 },
      render: (row) =>
        React.createElement(BudgetProgress, {
          R: React, M: MaterialCore, label: '', used: row.currentMonthCostUsd,
          limit: row.monthlyCostLimitUsd, threshold: row.alertThresholdPercent,
          format: (v: unknown) => fmtUsd(v, 2),
        }),
    },
    {
      title: 'Hard Stop',
      render: (row) =>
        row.hasBudget && row.hardStop
          ? React.createElement(Icon, { sx: { color: '#f97316', fontSize: 18 } }, 'gpp_maybe')
          : React.createElement(Typography, { variant: 'caption', color: 'text.secondary' }, '—'),
    },
  ];

  return React.createElement(
    Box,
    { sx: { p: { xs: 2, md: 3 }, bgcolor: 'background.default', minHeight: '100vh' } },
    header,
    loading ? React.createElement(LinearProgress, { sx: { mb: 2, borderRadius: 1 } }) : null,
    error ? React.createElement(Alert, { severity: 'error', sx: { mb: 2 }, onClose: () => setError(null) }, error) : null,
    notice ? React.createElement(Alert, { severity: 'success', sx: { mb: 2 }, onClose: () => setNotice(null) }, notice) : null,
    // KPI strip
    React.createElement(
      Grid,
      { container: true, spacing: 2, sx: { mb: 3 } },
      React.createElement(Grid, { item: true, xs: 12, sm: 6, md: 3, lg: 2 }, React.createElement(Kpi, { R: React, M: MaterialCore, label: 'Users', value: fmtInt(kpis.total), icon: 'group', accent: '#38bdf8' })),
      React.createElement(Grid, { item: true, xs: 12, sm: 6, md: 3, lg: 2 }, React.createElement(Kpi, { R: React, M: MaterialCore, label: 'Budgeted', value: fmtInt(kpis.budgeted), icon: 'account_balance_wallet', accent: '#22c55e' })),
      React.createElement(Grid, { item: true, xs: 12, sm: 6, md: 3, lg: 2 }, React.createElement(Kpi, { R: React, M: MaterialCore, label: 'Unbudgeted', value: fmtInt(kpis.unbudgeted), icon: 'money_off', accent: '#94a3b8' })),
      React.createElement(Grid, { item: true, xs: 12, sm: 6, md: 3, lg: 3 }, React.createElement(Kpi, { R: React, M: MaterialCore, label: 'At / Over Threshold', value: fmtInt(kpis.overThreshold), icon: 'warning_amber', accent: '#fbbf24' })),
      React.createElement(Grid, { item: true, xs: 12, sm: 6, md: 3, lg: 3 }, React.createElement(Kpi, { R: React, M: MaterialCore, label: 'Hard Stop On', value: fmtInt(kpis.hardStop), icon: 'gpp_maybe', accent: '#f97316' })),
    ),

    // Toolbar
    React.createElement(
      Paper,
      { variant: 'outlined', sx: { p: 2, mb: 2, borderRadius: '14px' } },
      React.createElement(
        Box,
        { sx: { display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' } },
        React.createElement(TextField, {
          size: 'small', label: 'Find user', placeholder: 'name, email or id',
          value: search, onChange: (e: any) => setSearch(e.target.value), sx: { flex: '1 1 260px', minWidth: 220 },
        }),
        React.createElement(TextField, {
          select: true, size: 'small', label: 'Show', value: budgetFilter,
          onChange: (e: any) => setBudgetFilter(e.target.value), sx: { width: 190 },
        },
          React.createElement(MenuItem, { value: 'all' }, 'All users'),
          React.createElement(MenuItem, { value: 'budgeted' }, 'Budgeted only'),
          React.createElement(MenuItem, { value: 'unbudgeted' }, 'Unbudgeted only'),
        ),
        React.createElement(Box, { sx: { flex: 1 } }),
        selectedUserIds.length > 0
          ? React.createElement(Chip, { size: 'small', color: 'primary', variant: 'outlined', label: `${selectedUserIds.length} selected`, onDelete: () => setSelected({}) })
          : null,
        React.createElement(Button, { variant: 'outlined', startIcon: React.createElement(Icon, null, 'done_all'), disabled: selectedUserIds.length === 0, onClick: openBulk }, 'Apply to selected'),
        React.createElement(Button, {
          variant: 'outlined', color: 'error', startIcon: React.createElement(Icon, null, 'delete_sweep'),
          disabled: selectedUserIds.length === 0,
          onClick: () => setConfirm({ kind: 'bulk-delete', userIds: selectedUserIds }),
        }, 'Remove selected'),
        React.createElement(Button, { variant: 'contained', startIcon: React.createElement(Icon, null, 'add'), onClick: openNew }, 'New budget'),
      ),
    ),

    // Table
    React.createElement(
      TableContainer,
      { component: Paper, variant: 'outlined', sx: { borderRadius: '12px', overflow: 'auto' } },
      React.createElement(
        Table,
        { size: 'small' },
        React.createElement(
          TableHead,
          null,
          React.createElement(
            TableRow,
            null,
            React.createElement(TableCell, { padding: 'checkbox' },
              React.createElement(Checkbox, {
                size: 'small',
                checked: allFilteredSelected,
                indeterminate: !allFilteredSelected && filtered.some((r) => selected[r.userId]),
                onChange: (_e: any, checked: boolean) => {
                  const next = { ...selected };
                  filtered.forEach((r) => {
                    if (checked) next[r.userId] = true;
                    else delete next[r.userId];
                  });
                  setSelected(next);
                },
              }),
            ),
            ...columns.map((c, i) => React.createElement(TableCell, { key: i, align: c.align || 'left', sx: { fontWeight: 700, whiteSpace: 'nowrap' } }, c.title)),
            React.createElement(TableCell, { align: 'right', sx: { fontWeight: 700 } }, 'Actions'),
          ),
        ),
        React.createElement(
          TableBody,
          null,
          filtered.length === 0
            ? React.createElement(
                TableRow,
                null,
                React.createElement(TableCell, { colSpan: columns.length + 2, sx: { py: 4, textAlign: 'center' } },
                  React.createElement(Typography, { variant: 'body2', color: 'text.secondary' },
                    rows.length === 0 ? 'No users returned.' : 'No users match the current filter.'),
                ),
              )
            : filtered.map((row) =>
                React.createElement(
                  TableRow,
                  { key: row.userId, hover: true },
                  React.createElement(TableCell, { padding: 'checkbox' },
                    React.createElement(Checkbox, {
                      size: 'small', checked: Boolean(selected[row.userId]),
                      onChange: (_e: any, checked: boolean) => {
                        setSelected((prev) => {
                          const next = { ...prev };
                          if (checked) next[row.userId] = true;
                          else delete next[row.userId];
                          return next;
                        });
                      },
                    }),
                  ),
                  ...columns.map((c, i) => React.createElement(TableCell, { key: i, align: c.align || 'left', sx: c.sx }, c.render(row))),
                  React.createElement(
                    TableCell,
                    { align: 'right', sx: { whiteSpace: 'nowrap' } },
                    React.createElement(Tooltip, { title: 'View this user\'s usage' },
                      React.createElement(IconButton, { size: 'small', onClick: () => navigate(`/admin/ai/usage/${row.userId}`) },
                        React.createElement(Icon, { fontSize: 'small' }, 'query_stats'))),
                    React.createElement(Tooltip, { title: row.hasBudget ? 'Edit budget' : 'Set a budget' },
                      React.createElement(IconButton, { size: 'small', onClick: () => openEdit(row) },
                        React.createElement(Icon, { fontSize: 'small' }, row.hasBudget ? 'edit' : 'add_circle_outline'))),
                    React.createElement(Tooltip, { title: row.hasBudget ? 'Remove budget' : 'No budget to remove' },
                      React.createElement('span', null,
                        React.createElement(IconButton, {
                          size: 'small', color: 'error', disabled: !row.budget?.id,
                          onClick: () => setConfirm({ kind: 'delete', row }),
                        }, React.createElement(Icon, { fontSize: 'small' }, 'delete')))),
                  ),
                ),
              ),
        ),
      ),
    ),
    React.createElement(Typography, { variant: 'caption', color: 'text.secondary', sx: { display: 'block', mt: 1 } },
      `Showing ${fmtInt(filtered.length)} of ${fmtInt(rows.length)} users (loaded up to ${fmtInt(OVERVIEW_LIMIT)}).`),

    // Editor dialog
    R_createEditor(React, MaterialCore, {
      open: editorOpen,
      mode: editorMode,
      form: editorForm,
      userOptions,
      selectedCount: selectedUserIds.length,
      saving,
      onClose: () => (saving ? undefined : setEditorOpen(false)),
      onField: setField,
      onSave: () => (editorMode === 'bulk' ? saveBulk() : saveSingle()),
    }),

    // Confirm dialog
    confirm
      ? React.createElement(ConfirmDialog, {
          R: React, M: MaterialCore, open: true,
          busy: confirmBusy,
          title: confirm.kind === 'delete' ? 'Remove budget' : 'Remove budgets',
          message:
            confirm.kind === 'delete'
              ? `Remove the AI budget for ${userLabel(confirm.row)}? Their AI access is unaffected — only the quota and hard stop are deleted.`
              : `Remove the AI budget for ${confirm.userIds.length} selected user(s)? Users without a budget are skipped.`,
          confirmLabel: confirm.kind === 'delete' ? 'Remove' : `Remove ${confirm.userIds.length}`,
          onCancel: () => (confirmBusy ? undefined : setConfirm(null)),
          onConfirm: () => (confirm.kind === 'delete' ? removeBudget(confirm.row) : removeBulk(confirm.userIds)),
        })
      : null,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Header / footer / editor factories (module scope; keep the main body readable)
// ─────────────────────────────────────────────────────────────────────────────

function R_createHeader(
  React: any,
  M: any,
  opts: { isSelf: boolean; onRefresh: () => void; loading: boolean },
) {
  const { Box, Typography, Icon, Button, CircularProgress } = M;
  const { isSelf, onRefresh, loading } = opts;
  return React.createElement(
    Box,
    { sx: { mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 } },
    React.createElement(
      Box,
      null,
      React.createElement(
        Box,
        { sx: { display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 } },
        React.createElement(Icon, { sx: { color: '#38bdf8', fontSize: 34 } }, 'account_balance_wallet'),
        React.createElement(Typography, { variant: 'h4', sx: { fontWeight: 700 } }, isSelf ? 'My AI Budget' : 'AI Usage Budgets'),
      ),
      React.createElement(Typography, { variant: 'body1', color: 'text.secondary' },
        isSelf
          ? 'Your AI token and spend budget for this account, and how much of it you have used.'
          : 'Configure AI token and cost limits per user, see who is unbudgeted, and act on them in bulk.'),
    ),
    React.createElement(
      Box,
      { sx: { display: 'flex', gap: 1.5, alignItems: 'center' } },
      React.createElement(Button, {
        variant: 'outlined',
        startIcon: loading ? React.createElement(CircularProgress, { size: 18 }) : React.createElement(Icon, null, 'sync'),
        disabled: loading, onClick: onRefresh,
      }, 'Refresh'),
    ),
  );
}

function R_createFooter(React: any, M: any, onOpenUsage: () => void) {
  const { Box, Divider, Typography, Button, Icon } = M;
  return React.createElement(
    Box,
    { sx: { mt: 3 } },
    React.createElement(Divider, { sx: { mb: 2 } }),
    React.createElement(
      Box,
      { sx: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' } },
      React.createElement(Typography, { variant: 'caption', color: 'text.secondary' },
        'Limits are advisory unless "Hard Stop" is enabled, in which case turns are blocked once a limit is exceeded.'),
      React.createElement(Button, {
        variant: 'text', startIcon: React.createElement(Icon, null, 'query_stats'), onClick: onOpenUsage,
      }, 'View my usage'),
    ),
  );
}

function R_createEditor(
  React: any,
  M: any,
  opts: {
    open: boolean;
    mode: 'single' | 'bulk';
    form: BudgetForm;
    userOptions: Array<{ value: string; label: string; hasBudget: boolean }>;
    selectedCount: number;
    saving: boolean;
    onClose: () => void;
    onField: (key: keyof BudgetForm, value: any) => void;
    onSave: () => void;
  },
) {
  const {
    Dialog, DialogTitle, DialogContent, DialogActions, Button, Icon, Typography, Grid, Box,
    TextField, Autocomplete, FormControlLabel, Switch, Alert, CircularProgress, Divider,
  } = M;
  const { open, mode, form, userOptions, selectedCount, saving, onClose, onField, onSave } = opts;

  const selectedOption = userOptions.find((o) => o.value === form.userId) || null;

  const numberField = (key: keyof BudgetForm, label: string, placeholder: string, xs: number) =>
    React.createElement(Grid, { item: true, xs: 12, sm: xs },
      React.createElement(TextField, {
        size: 'small', fullWidth: true, label, placeholder,
        value: form[key] as string,
        onChange: (e: any) => onField(key, e.target.value),
      }));

  return React.createElement(
    Dialog,
    { open, onClose: saving ? undefined : onClose, maxWidth: 'md', fullWidth: true },
    React.createElement(DialogTitle, null, mode === 'bulk' ? `Apply budget to ${selectedCount} user(s)` : 'User AI budget'),
    React.createElement(
      DialogContent,
      null,
      mode === 'bulk'
        ? React.createElement(Alert, { severity: 'info', sx: { mb: 2 } },
            `These limits will be written to all ${selectedCount} selected users. A blank field leaves that limit unchanged for each user; fill a field to overwrite it. "Hard stop" and notes are always applied.`)
        : null,
      React.createElement(
        Grid,
        { container: true, spacing: 2, sx: { pt: 0.5 } },
        React.createElement(Grid, { item: true, xs: 12, sm: 6 },
          React.createElement(Autocomplete, {
            size: 'small',
            disabled: mode === 'bulk' || Boolean(form.userId),
            options: userOptions,
            value: mode === 'bulk' ? null : selectedOption,
            onChange: (_e: any, value: any) => onField('userId', value?.value || ''),
            getOptionLabel: (o: any) => (o && o.label ? o.label : ''),
            isOptionEqualToValue: (a: any, b: any) => a.value === b.value,
            renderInput: (params: any) => React.createElement(TextField, { ...params, label: 'User', placeholder: 'Search name or email' }),
          })),
        React.createElement(Grid, { item: true, xs: 12, sm: 3 },
          React.createElement(TextField, {
            size: 'small', fullWidth: true, label: 'Warn threshold (%)', placeholder: '80',
            value: form.alertThresholdPercent, onChange: (e: any) => onField('alertThresholdPercent', e.target.value),
          })),
        React.createElement(Grid, { item: true, xs: 12, sm: 3 },
          React.createElement(FormControlLabel, {
            control: React.createElement(Switch, {
              checked: form.hardStop, onChange: (e: any) => onField('hardStop', e.target.checked),
            }),
            label: 'Hard stop',
          })),
        numberField('monthlyTokenLimit', 'Monthly token limit', 'e.g. 5000000 (blank = unlimited)', 6),
        numberField('dailyTokenLimit', 'Daily token limit', 'e.g. 500000 (blank = unlimited)', 6),
        numberField('monthlyCostLimitUsd', 'Monthly cost limit (USD)', 'e.g. 50.00 (blank = unlimited)', 6),
        numberField('dailyCostLimitUsd', 'Daily cost limit (USD)', 'e.g. 10.00 (blank = unlimited)', 6),
        React.createElement(Grid, { item: true, xs: 12 },
          React.createElement(TextField, {
            size: 'small', fullWidth: true, label: 'Notes', multiline: true, minRows: 2,
            value: form.notes, onChange: (e: any) => onField('notes', e.target.value),
          })),
        React.createElement(Grid, { item: true, xs: 12 },
          React.createElement(Typography, { variant: 'caption', color: 'text.secondary' },
            'Empty = unlimited. Set to 0 to block entirely when Hard Stop is on.')),
      ),
    ),
    React.createElement(
      DialogActions,
      null,
      React.createElement(Box, { sx: { flex: 1, display: 'flex', alignItems: 'center', gap: 1, pl: 1 } },
        React.createElement(Icon, { fontSize: 'small', sx: { color: 'text.secondary' } }, 'info'),
        React.createElement(Typography, { variant: 'caption', color: 'text.secondary' },
          mode === 'bulk' ? 'Applied to all selected users in one request.' : 'Saving again for the same user updates their budget.')),
      React.createElement(Button, { onClick: onClose, disabled: saving }, 'Cancel'),
      React.createElement(Button, {
        variant: 'contained', onClick: onSave, disabled: saving || (mode === 'single' && !form.userId),
        startIcon: saving ? React.createElement(CircularProgress, { size: 16 }) : React.createElement(Icon, null, 'save'),
      }, mode === 'bulk' ? `Apply to ${selectedCount}` : 'Save budget'),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

const Definition: any = {
  name: 'UserBudgetAdminWidget',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: UserBudgetAdminWidget,
  roles: ['USER', 'ADMIN', 'SUPERADMIN', 'DEVELOPER', 'SYSADMIN'],
};

//@ts-ignore
if (typeof window !== 'undefined' && window.reactory && window.reactory.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    UserBudgetAdminWidget,
    ['AI Usage', 'Budget', 'Admin', 'Users', 'Reactor'],
    Definition.roles,
    true,
    [],
    'widget',
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: UserBudgetAdminWidget,
  });
}

export default UserBudgetAdminWidget;
