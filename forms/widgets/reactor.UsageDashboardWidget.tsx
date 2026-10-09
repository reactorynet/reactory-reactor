import Reactory from '@reactorynet/reactory-core';

/**
 * reactor.UsageDashboardWidget
 *
 * The entire AI Usage & Telemetry dashboard as a single custom widget, built on
 * the same pattern as `compute_planner.ComputeDashboardWidget`:
 *
 *   - It owns its own state, filters and data fetching (no form-engine binding).
 *   - It calls `reactory.graphqlQuery` directly against the Reactor usage
 *     analytics resolvers, which derive everything from the Postgres message log.
 *   - It resolves its own React / Material / chart dependencies via
 *     `reactory.getComponents`.
 *   - It self-registers as `reactor.UsageDashboardWidget@1.0.0` so the form's
 *     `uiSchema` can reference it by FQN.
 *
 * The previous implementation drove the whole page through `uiSchema` +
 * `graphql.query` and had drifted: KPI data was bound to a single query, several
 * bindings were silently dropped, and the per-user drill-down rendered the
 * global view. A widget that owns its state is far harder to break that way.
 *
 * ── Honesty rules (non-negotiable, carried over from the old form) ───────────
 *
 *  1. No metric is fabricated. An empty ledger renders zeros / empty states —
 *     never a plausible-looking fixture. A wrong number that looks right is
 *     worse than a blank, because nobody investigates a blank.
 *  2. `costUsd === null` means "this model has no known price", NOT free. It is
 *     rendered as `—` and counted in `coverage.unpricedTurns`, never as $0.0000.
 *  3. `coverage` is always surfaced, so a total over 80% of turns is never read
 *     as a total over all of them.
 *  4. `usageSource === 'estimated'` stays visible; estimated turns are counted in
 *     coverage rather than presented as measured.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface UsageDashboardDependencies {
  React: Reactory.React;
  Material: Reactory.Client.Web.IMaterialModule;
  LineChart?: any;
  BarChart?: any;
  PieChart?: any;
  ComposedChart?: any;
}

interface UsageDashboardProps {
  reactory: Reactory.Client.IReactoryApi;
  formContext?: any;
  formData?: any;
  value?: any;
  uiSchema?: any;
  /** Route-bound scope (e.g. `${route.userId}` drill-down). */
  userId?: string;
  /** `scope: 'self'` marks the self-service view (/profile/usage). */
  scope?: string;
}

interface FilterState {
  startDate: string;
  endDate: string;
  provider: string;
  model: string;
  personaId: string;
  use_case: string;
  userId: string;
  userIds: string[];
}

interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsdCents: number;
  totalCostUsd: number;
  totalRequests: number;
  avgDurationMs: number | null;
  errorCount: number;
  errorRate: number;
  errorBreakdown: any[];
  timeSeries: any[];
  modelBreakdown: any[];
  providerBreakdown: any[];
  userBreakdown: any[] | null;
  coverage: any;
}

interface UsageLedger {
  records: any[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { value: 'all', label: 'All Providers' },
  { value: 'google', label: 'Google Vertex / Gemini' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'llamacpp', label: 'LlamaCPP' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
];

const USE_CASES = [
  { value: 'all', label: 'All Use Cases' },
  { value: 'standalone', label: 'Standalone Chat' },
  { value: 'workflow', label: 'Workflow Runner' },
  { value: 'support', label: 'Support Ticket' },
  { value: 'task', label: 'Scheduled Task' },
];

const ACCENTS = {
  tokens: '#38bdf8',
  prompt: '#818cf8',
  completion: '#34d399',
  cost: '#fbbf24',
  turns: '#c084fc',
  latency: '#f87171',
  errors: '#fb7185',
};

const SUMMARY_QUERY = `query ReactorAIUsageSummary($filter: ReactorUsageFilterInput) {
  ReactorAIUsageSummary(filter: $filter) {
    totalPromptTokens
    totalCompletionTokens
    totalTokens
    totalCostUsdCents
    totalCostUsd
    totalRequests
    avgDurationMs
    errorCount
    errorRate
    errorBreakdown {
      provider
      model
      failures
      retryableFailures
      totalAttempts
      lastErrorCode
      lastErrorMessage
    }
    timeSeries {
      date
      promptTokens
      completionTokens
      totalTokens
      costUsdCents
      costUsd
      requests
      failures
    }
    modelBreakdown {
      model
      provider
      promptTokens
      completionTokens
      totalTokens
      costUsdCents
      costUsd
      requests
    }
    providerBreakdown {
      provider
      totalTokens
      costUsdCents
      costUsd
      requests
    }
    userBreakdown {
      userId
      firstName
      lastName
      email
      totalTokens
      costUsdCents
      costUsd
      requests
    }
    coverage {
      turns
      attributedTurns
      pricedTurns
      unpricedTurns
      estimatedTurns
      zeroUsageTurns
      reroutedTurns
    }
  }
}`;

const LEDGER_QUERY = `query ReactorAIUsageList($filter: ReactorUsageFilterInput, $page: Int, $pageSize: Int) {
  ReactorAIUsageList(filter: $filter, page: $page, pageSize: $pageSize) {
    records {
      id
      userId
      user { firstName lastName email }
      personaId
      provider
      model
      promptTokens
      completionTokens
      totalTokens
      costUsd
      durationMs
      use_case
      usageSource
      status
      createdAt
    }
    total
    page
    pageSize
    hasNext
  }
}`;

const STATUS_QUERY = `query ReactorUserUsageStatus {
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

// ── Filter-option lookups ────────────────────────────────────────────────────
// Providers, models and personas come from the same registry the rest of the
// platform reads, so the dashboard filters on real ids rather than a hardcoded
// enum. All three resolvers only require an authenticated user (no admin role),
// so they are safe for the /profile/usage view too.
const PROVIDERS_QUERY = `query UsageFilterProviders {
  ReactorAiProvidersAdmin(paging: { page: 1, pageSize: 200 }) {
    providers {
      id
      name
      providerType
      isEnabled
    }
  }
}`;

const MODELS_QUERY = `query UsageFilterModels {
  ReactorAiModelsAdmin(paging: { page: 1, pageSize: 1000 }) {
    models {
      id
      name
      providerId
      isEnabled
    }
  }
}`;

const PERSONAS_QUERY = `query UsageFilterPersonas {
  ReactorPersonas {
    id
    name
    provider
    modelId
  }
}`;

interface FilterOption {
  value: string;
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const fmtInt = (value: unknown): string => toNumber(value).toLocaleString();

const fmtUsd = (value: unknown, decimals = 2): string => {
  const n = toNumber(value);
  return `$${n.toFixed(decimals)}`;
};

/** Totals are always priced-or-not-priced as a whole; `0` is honest here. */
const fmtCostTotal = (value: unknown): string => {
  const n = toNumber(value);
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};

/** A per-row cost of `null` means "no known price" — never render as $0.0000. */
const fmtCostRow = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  const n = toNumber(value);
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};

const pct = (part: unknown, whole: unknown): number => {
  const w = toNumber(whole);
  if (w <= 0) return 0;
  return Math.round((toNumber(part) / w) * 100);
};

const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

const shortDate = (value: string): string => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const isRealComponent = (comp: any): boolean =>
  typeof comp === 'function' && comp.name !== 'NotFoundComponent';

const isFailureStatus = (status: unknown): boolean => {
  const s = String(status || '').toLowerCase();
  return s.includes('fail') || s.includes('error');
};

const userLabel = (row: any): string => {
  if (!row) return '—';
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
  return row.email || name || row.userId || '—';
};

/** Build the GraphQL filter from local state, omitting empties and `all`. */
const buildFilter = (f: FilterState, scopedUserId?: string): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};
  if (f.startDate) filter.startDate = f.startDate;
  if (f.endDate) filter.endDate = f.endDate;
  if (f.provider && f.provider !== 'all') filter.provider = f.provider;
  if (f.use_case && f.use_case !== 'all') filter.use_case = f.use_case;
  if (f.model) filter.model = f.model.trim();
  if (f.personaId) filter.personaId = f.personaId.trim();

  if (scopedUserId) {
    // Route-bound scope always wins (/admin/ai/usage/:userId, /profile/usage).
    filter.userId = scopedUserId;
  } else {
    if (f.userIds && f.userIds.length > 0) filter.userIds = f.userIds;
    else if (f.userId) filter.userId = f.userId.trim();
  }
  return filter;
};

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational building blocks (module scope — stable identity)
// ─────────────────────────────────────────────────────────────────────────────

const KpiCard = (props: {
  R: any;
  M: any;
  label: string;
  value: string;
  sub?: string;
  icon: string;
  accent: string;
}) => {
  const { R, M, label, value, sub, icon, accent } = props;
  const { Paper, Box, Typography, Icon } = M;

  return R.createElement(
    Paper,
    {
      elevation: 0,
      variant: 'outlined',
      sx: {
        p: 2.2,
        height: '100%',
        borderRadius: '14px',
        bgcolor: 'background.paper',
        borderTop: `4px solid ${accent}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        transition: 'all 0.2s ease-in-out',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: `0 8px 24px ${accent}33`,
        },
      },
    },
    R.createElement(
      Box,
      { sx: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      R.createElement(
        Typography,
        {
          variant: 'caption',
          color: 'text.secondary',
          sx: { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' },
        },
        label,
      ),
      R.createElement(
        Box,
        {
          sx: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: '8px',
            bgcolor: `${accent}22`,
            color: accent,
          },
        },
        R.createElement(Icon, { sx: { fontSize: 18 } }, icon),
      ),
    ),
    R.createElement(
      Typography,
      {
        variant: 'h6',
        sx: { fontWeight: 700, fontFamily: 'monospace', color: accent, lineHeight: 1.2 },
      },
      value,
    ),
    sub
      ? R.createElement(Typography, { variant: 'caption', color: 'text.secondary' }, sub)
      : null,
  );
};

const UsageTable = (props: {
  R: any;
  M: any;
  columns: Array<{ title: string; field?: string; align?: 'left' | 'right' | 'center'; render?: (row: any) => any; sx?: any }>;
  rows: any[];
  emptyText?: string;
  maxHeight?: number;
}) => {
  const { R, M, columns, rows, emptyText, maxHeight } = props;
  const { Table, TableHead, TableBody, TableRow, TableCell, TableContainer, Paper, Typography } = M;

  if (!rows || rows.length === 0) {
    return R.createElement(
      Typography,
      { variant: 'body2', color: 'text.secondary', sx: { p: 2 } },
      emptyText || 'No data for the selected window.',
    );
  }

  return R.createElement(
    TableContainer,
    {
      component: Paper,
      variant: 'outlined',
      sx: { borderRadius: '12px', maxHeight: maxHeight || undefined, overflow: maxHeight ? 'auto' : undefined },
    },
    R.createElement(
      Table,
      { size: 'small', stickyHeader: Boolean(maxHeight) },
      R.createElement(
        TableHead,
        null,
        R.createElement(
          TableRow,
          null,
          ...columns.map((c, i) =>
            R.createElement(
              TableCell,
              { key: i, align: c.align || 'left', sx: { fontWeight: 700, whiteSpace: 'nowrap' } },
              c.title,
            ),
          ),
        ),
      ),
      R.createElement(
        TableBody,
        null,
        ...rows.map((row, ri) =>
          R.createElement(
            TableRow,
            { key: ri, hover: true },
            ...columns.map((c, ci) =>
              R.createElement(
                TableCell,
                { key: ci, align: c.align || 'left', sx: c.sx },
                c.render ? c.render(row) : row[c.field] ?? '—',
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

const SectionCard = (props: { R: any; M: any; title: string; subtitle?: string; action?: any; children?: any }) => {
  const { R, M, title, subtitle, action, children } = props;
  const { Card, CardContent, Box, Typography } = M;

  return R.createElement(
    Card,
    { variant: 'outlined', sx: { height: '100%', borderRadius: '14px' } },
    R.createElement(
      CardContent,
      null,
      R.createElement(
        Box,
        { sx: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 } },
        R.createElement(
          Box,
          null,
          R.createElement(Typography, { variant: 'h6', sx: { fontWeight: 600 } }, title),
          subtitle
            ? R.createElement(Typography, { variant: 'body2', color: 'text.secondary' }, subtitle)
            : null,
        ),
        action || null,
      ),
      children,
    ),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Widget
// ─────────────────────────────────────────────────────────────────────────────

const UsageDashboardWidget = (props: UsageDashboardProps) => {
  const { reactory, formContext } = props;

  const { React, Material, LineChart, BarChart } = reactory.getComponents<UsageDashboardDependencies>([
    'react.React',
    'material-ui.Material',
    'core.LineChart',
    'core.BarChart',
  ]);

  const MaterialCore = (Material && Material.MaterialCore) || {};
  const {
    Box,
    Typography,
    Grid,
    Paper,
    Divider,
    Button,
    Icon,
    Chip,
    Alert,
    TextField,
    MenuItem,
    Autocomplete,
    LinearProgress,
    CircularProgress,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
  } = MaterialCore;

  // ── Scope resolution ───────────────────────────────────────────────────────
  // Route-bound `componentProps` (e.g. userId) reach the form as React props and
  // live on the form context, not on the widget directly. Read all plausible
  // locations so the drill-down / self-service routes actually scope.
  const contextProps = (formContext && (formContext.props || (formContext.$ref && formContext.$ref.props))) || {};

  // ── Self-scope resolution (/profile/usage) ─────────────────────────────────
  // The self-service route cannot template the API user: `processTemplateStrings`
  // only exposes `{ route, location, query }`, so a `${reactory.user.id}` binding
  // arrives unresolved — and the top-level `reactory.user.id` is the *application*
  // id anyway. The real per-user id lives on the ApiStatus payload at
  // `loggedIn.user.id` (the same path the client Comments view and
  // `getApplicationRoles` use). Derive it here so "My Usage" actually scopes.
  const resolveCurrentUserId = (): string => {
    try {
      const api: any = reactory;
      const apiUser: any = typeof api?.getUser === 'function' ? api.getUser() : api?.user;
      return apiUser?.loggedIn?.user?.id || '';
    } catch (err) {
      return '';
    }
  };

  const [currentUserId, setCurrentUserId] = React.useState<string>(() => resolveCurrentUserId());
  React.useEffect(() => {
    const sync = () => {
      const next = resolveCurrentUserId();
      setCurrentUserId((prev) => (prev === next ? prev : next));
    };
    sync();
    // ApiStatus can resolve after first paint on a cold load; re-derive when it
    // does so the self-scoped fetch is not stuck on an empty id.
    const api: any = reactory;
    if (typeof api?.on === 'function') api.on('onApiStatusUpdate', sync);
    return () => {
      if (typeof api?.off === 'function') api.off('onApiStatusUpdate', sync);
    };
  }, [reactory]);

  const rawUserId: string = props.userId || contextProps.userId || '';
  const requestedScope: string = props.scope || contextProps.scope || '';
  // An unresolved `${...}` literal is the fingerprint of the old
  // `${reactory.user.id}` binding; treat it (and an explicit `scope: 'self'`) as
  // the self-service view. Admin routes carry a resolved id or nothing at all,
  // so they are never re-scoped to the viewer.
  const isUnresolvedTemplate = typeof rawUserId === 'string' && rawUserId.indexOf('${') >= 0;
  const isSelfScoped = requestedScope === 'self' || isUnresolvedTemplate;
  const scopedUserId: string = isSelfScoped
    ? currentUserId
    : (isUnresolvedTemplate ? '' : rawUserId);

  // ── Default window: trailing 30 days, computed at mount ─────────────────────
  const defaultWindow = (): { startDate: string; endDate: string } => {
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
    return { startDate: isoDate(start), endDate: isoDate(end) };
  };

  const emptyFilters: FilterState = {
    ...defaultWindow(),
    provider: 'all',
    use_case: 'all',
    model: '',
    personaId: '',
    userId: '',
    userIds: [],
  };

  const [draft, setDraft] = React.useState<FilterState>(emptyFilters);
  const [applied, setApplied] = React.useState<FilterState>(emptyFilters);

  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [ledger, setLedger] = React.useState<UsageLedger | null>(null);
  const [userStatus, setUserStatus] = React.useState<any>(null);

  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

  const [ledgerPage, setLedgerPage] = React.useState<number>(1);
  const [ledgerPageSize, setLedgerPageSize] = React.useState<number>(10);
  const [autoRefresh, setAutoRefresh] = React.useState<boolean>(false);

  // Filter-option lookups — fetched once; failures degrade to the static
  // provider list / free selection rather than blocking the dashboard.
  const [providers, setProviders] = React.useState<any[]>([]);
  const [models, setModels] = React.useState<any[]>([]);
  const [personas, setPersonas] = React.useState<any[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled([
        (reactory as any).graphqlQuery(PROVIDERS_QUERY, {}),
        (reactory as any).graphqlQuery(MODELS_QUERY, {}),
        (reactory as any).graphqlQuery(PERSONAS_QUERY, {}),
      ]);
      if (cancelled) return;
      const pick = (settled: any, key: string): any[] => {
        if (!settled || settled.status !== 'fulfilled') return [];
        const value = settled.value;
        const data = value && value.data ? value.data : value;
        const node = data && data[key];
        if (Array.isArray(node)) return node;
        if (node && Array.isArray(node.providers)) return node.providers;
        if (node && Array.isArray(node.models)) return node.models;
        return [];
      };
      setProviders(pick(results[0], 'ReactorAiProvidersAdmin'));
      setModels(pick(results[1], 'ReactorAiModelsAdmin'));
      setPersonas(pick(results[2], 'ReactorPersonas'));
    })();
    return () => {
      cancelled = true;
    };
  }, [reactory]);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchData = React.useCallback(async () => {
    setLoading(true);
    setError(null);

    const filter = buildFilter(applied, scopedUserId);

    const unwrap = (settled: any): { data: any; error: string | null } => {
      if (!settled || settled.status !== 'fulfilled') {
        const reason = settled && settled.reason;
        return { data: null, error: reason && reason.message ? reason.message : 'Request failed' };
      }
      const value = settled.value;
      const data = value && value.data ? value.data : value;
      const errors = value && value.errors;
      if (errors && errors.length) {
        return { data, error: errors.map((e: any) => e.message).filter(Boolean).join('; ') || 'GraphQL error' };
      }
      return { data, error: null };
    };

    const [summaryRes, ledgerRes, statusRes] = await Promise.allSettled([
      (reactory as any).graphqlQuery(SUMMARY_QUERY, { filter }),
      (reactory as any).graphqlQuery(LEDGER_QUERY, { filter, page: ledgerPage, pageSize: ledgerPageSize }),
      scopedUserId ? (reactory as any).graphqlQuery(STATUS_QUERY, {}) : Promise.resolve(null),
    ]);

    const summaryOut = unwrap(summaryRes);
    const ledgerOut = unwrap(ledgerRes);
    const statusOut = scopedUserId ? unwrap(statusRes) : { data: null, error: null };

    setSummary(summaryOut.data ? summaryOut.data.ReactorAIUsageSummary || null : null);
    setLedger(ledgerOut.data ? ledgerOut.data.ReactorAIUsageList || null : null);
    setUserStatus(statusOut.data ? statusOut.data.ReactorUserUsageStatus || null : null);

    const firstError = summaryOut.error || ledgerOut.error;
    setError(firstError || null);
    setLastUpdated(new Date());
    setLoading(false);
  }, [reactory, applied, ledgerPage, ledgerPageSize, scopedUserId]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  React.useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(() => {
      fetchData();
    }, 60000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  // ── Filter handlers ────────────────────────────────────────────────────────
  const applyFilters = () => {
    setApplied({ ...draft });
    setLedgerPage(1);
  };

  const resetFilters = () => {
    const next = { ...emptyFilters };
    setDraft(next);
    setApplied(next);
    setLedgerPage(1);
  };

  const applyQuickRange = (kind: string) => {
    let startDate = '';
    let endDate = isoDate(new Date());
    const end = new Date();
    if (kind === '7d') startDate = isoDate(new Date(end.getTime() - 6 * 86400000));
    else if (kind === '30d') startDate = isoDate(new Date(end.getTime() - 29 * 86400000));
    else if (kind === '90d') startDate = isoDate(new Date(end.getTime() - 89 * 86400000));
    else if (kind === 'mtd') startDate = isoDate(new Date(end.getFullYear(), end.getMonth(), 1));
    else if (kind === 'ytd') startDate = isoDate(new Date(end.getFullYear(), 0, 1));
    else {
      startDate = '';
      endDate = '';
    }
    const next = { ...draft, startDate, endDate };
    setDraft(next);
    setApplied(next);
    setLedgerPage(1);
  };

  const setDraftField = (key: keyof FilterState, value: any) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  // ── Derived ────────────────────────────────────────────────────────────────
  const coverage = (summary && summary.coverage) || {};
  const modelRows = [...((summary && summary.modelBreakdown) || [])].sort(
    (a, b) => toNumber(b.totalTokens) - toNumber(a.totalTokens),
  );
  const providerRows = [...((summary && summary.providerBreakdown) || [])].sort(
    (a, b) => toNumber(b.totalTokens) - toNumber(a.totalTokens),
  );
  const userRows = [...((summary && summary.userBreakdown) || [])].sort(
    (a, b) => toNumber(b.totalTokens) - toNumber(a.totalTokens),
  );
  const failureRows = [...((summary && summary.errorBreakdown) || [])].sort(
    (a, b) => toNumber(b.failures) - toNumber(a.failures),
  );
  const timeSeries = (summary && summary.timeSeries) || [];

  const providerOptions: FilterOption[] = React.useMemo(() => {
    const live = providers
      .filter((p: any) => p && p.id && p.isEnabled !== false)
      .map((p: any) => ({ value: String(p.id), label: p.name ? String(p.name) : String(p.id) }))
      .sort((a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label));
    const base = live.length > 0
      ? live
      : PROVIDERS.filter((o) => o.value !== 'all').map((o) => ({ value: o.value, label: o.label }));
    return [{ value: 'all', label: 'All Providers' }, ...base];
  }, [providers]);

  const modelOptions: FilterOption[] = React.useMemo(() => {
    const scopedByProvider = draft.provider && draft.provider !== 'all'
      ? models.filter((m: any) => String(m.providerId) === draft.provider)
      : models;
    return scopedByProvider
      .filter((m: any) => m && m.id)
      .map((m: any) => ({
        value: String(m.id),
        label: m.name ? `${m.name} · ${m.id}` : String(m.id),
      }))
      .sort((a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label));
  }, [models, draft.provider]);

  const personaOptions: FilterOption[] = React.useMemo(
    () =>
      personas
        .filter((p: any) => p && p.id)
        .map((p: any) => ({
          value: String(p.id),
          label: p.name ? `${p.name} · ${p.id}` : String(p.id),
        }))
        .sort((a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label)),
    [personas],
  );

  const findOption = (options: FilterOption[], value: string): FilterOption | null =>
    options.find((o) => o.value === value) || null;

  const trendData = timeSeries.map((p: any) => ({
    date: shortDate(p.date),
    totalTokens: toNumber(p.totalTokens),
    promptTokens: toNumber(p.promptTokens),
    completionTokens: toNumber(p.completionTokens),
  }));

  const usageData = timeSeries.map((p: any) => ({
    date: shortDate(p.date),
    requests: toNumber(p.requests),
    failures: toNumber(p.failures),
  }));

  const hasAnyData =
    summary !== null &&
    (toNumber(summary.totalRequests) > 0 || toNumber(summary.totalTokens) > 0 || (summary.userBreakdown || []).length > 0);

  const coverageWarnings: string[] = [];
  if (coverage.unpricedTurns) coverageWarnings.push(`${coverage.unpricedTurns} turn(s) excluded from cost — no known price`);
  if (coverage.estimatedTurns) coverageWarnings.push(`${coverage.estimatedTurns} turn(s) used estimated token counts`);
  if (coverage.reroutedTurns) coverageWarnings.push(`${coverage.reroutedTurns} turn(s) were re-routed from the declared provider`);
  if (coverage.zeroUsageTurns) coverageWarnings.push(`${coverage.zeroUsageTurns} turn(s) reported zero usage`);

  const budget = userStatus && userStatus.budget;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: 'background.default', minHeight: '100vh' }}>
      {/* Header */}
      <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
            <Icon sx={{ color: ACCENTS.tokens, fontSize: 34 }}>insights</Icon>
            <Typography variant="h4" sx={{ fontWeight: 700 }}>
              AI Usage &amp; Telemetry
            </Typography>
          </Box>
          <Typography variant="body1" color="text.secondary">
            Token consumption, provider activity and spend, derived from the conversation message log.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            {scopedUserId ? (
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                icon={<Icon>person</Icon>}
                label={isSelfScoped ? 'Scoped to you' : `Scoped to ${scopedUserId}`}
              />
            ) : (
              <Chip size="small" variant="outlined" label="All users" />
            )}
            {lastUpdated ? (
              <Chip size="small" variant="outlined" label={`Updated ${lastUpdated.toLocaleTimeString()}`} />
            ) : null}
          </Box>
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={loading ? <CircularProgress size={18} /> : <Icon>sync</Icon>}
            disabled={loading}
            onClick={fetchData}
          >
            Refresh
          </Button>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={autoRefresh ? 'on' : 'off'}
            onChange={(_e: any, value: any) => {
              if (value) setAutoRefresh(value === 'on');
            }}
          >
            <ToggleButton value="off">
              <Tooltip title="Manual refresh">
                <Icon sx={{ fontSize: 18 }}>pause</Icon>
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="on">
              <Tooltip title="Auto-refresh every 60s">
                <Icon sx={{ fontSize: 18 }}>autorenew</Icon>
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      {loading ? <LinearProgress sx={{ mb: 2, borderRadius: 1 }} /> : null}

      {error ? (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      {/* Filter bar */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3, borderRadius: '14px' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Filters
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {[
              { key: '7d', label: '7D' },
              { key: '30d', label: '30D' },
              { key: '90d', label: '90D' },
              { key: 'mtd', label: 'MTD' },
              { key: 'ytd', label: 'YTD' },
              { key: 'all', label: 'All' },
            ].map((r) => (
              <Chip key={r.key} size="small" label={r.label} onClick={() => applyQuickRange(r.key)} variant="outlined" />
            ))}
          </Box>
        </Box>

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6} md={2}>
            <TextField
              label="Start Date"
              type="date"
              size="small"
              fullWidth
              value={draft.startDate}
              onChange={(e: any) => setDraftField('startDate', e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <TextField
              label="End Date"
              type="date"
              size="small"
              fullWidth
              value={draft.endDate}
              onChange={(e: any) => setDraftField('endDate', e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <TextField
              select
              label="Provider"
              size="small"
              fullWidth
              value={draft.provider}
              onChange={(e: any) => {
                const nextProvider = e.target.value;
                setDraft((prev) => {
                  // Drop a model that does not belong to the newly selected
                  // provider, so the model dropdown and the applied filter can
                  // never disagree.
                  const stillValid =
                    !prev.model ||
                    nextProvider === 'all' ||
                    models.some((m: any) => String(m.providerId) === nextProvider && String(m.id) === prev.model);
                  return { ...prev, provider: nextProvider, model: stillValid ? prev.model : '' };
                });
              }}
            >
              {providerOptions.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <TextField
              select
              label="Use Case"
              size="small"
              fullWidth
              value={draft.use_case}
              onChange={(e: any) => setDraftField('use_case', e.target.value)}
            >
              {USE_CASES.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <Autocomplete
              size="small"
              options={modelOptions}
              value={findOption(modelOptions, draft.model)}
              onChange={(_e: any, value: any) => setDraftField('model', value && value.value ? value.value : '')}
              isOptionEqualToValue={(a: any, b: any) => a.value === b.value}
              getOptionLabel={(o: any) => (o && o.label ? o.label : '')}
              noOptionsText={models.length === 0 ? 'No models available' : 'No models for this provider'}
              renderInput={(params: any) => (
                <TextField {...params} label="Model" placeholder="All models" />
              )}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <Autocomplete
              size="small"
              options={personaOptions}
              value={findOption(personaOptions, draft.personaId)}
              onChange={(_e: any, value: any) => setDraftField('personaId', value && value.value ? value.value : '')}
              isOptionEqualToValue={(a: any, b: any) => a.value === b.value}
              getOptionLabel={(o: any) => (o && o.label ? o.label : '')}
              noOptionsText="No personas available"
              renderInput={(params: any) => (
                <TextField {...params} label="Persona" placeholder="All personas" />
              )}
            />
          </Grid>

          {!scopedUserId ? (
            <>
              <Grid item xs={12} sm={6} md={4}>
                <TextField
                  label="User (single)"
                  size="small"
                  fullWidth
                  placeholder="user id or email"
                  value={draft.userId}
                  disabled={draft.userIds.length > 0}
                  onChange={(e: any) => setDraftField('userId', e.target.value)}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter') applyFilters();
                  }}
                  helperText={draft.userIds.length > 0 ? 'Ignored while a user selection is set' : undefined}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={5}>
                <Autocomplete
                  multiple
                  freeSolo
                  size="small"
                  options={[]}
                  value={draft.userIds}
                  onChange={(_e: any, value: any) => {
                    const next = (value || []).map((v: any) => String(v).trim()).filter(Boolean);
                    setDraft((prev) => ({ ...prev, userIds: next }));
                  }}
                  renderTags={(value: any[], getTagProps: any) =>
                    value.map((option: any, index: number) => (
                      <Chip variant="outlined" size="small" label={option} {...getTagProps({ index })} />
                    ))
                  }
                  renderInput={(params: any) => (
                    <TextField {...params} label="Users (selection)" placeholder="Add id or email, press Enter" />
                  )}
                />
              </Grid>
            </>
          ) : null}

          <Grid item xs={12} md={3} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            <Button variant="contained" onClick={applyFilters} startIcon={<Icon>filter_alt</Icon>} sx={{ fontWeight: 600 }}>
              Apply
            </Button>
            <Button variant="text" onClick={resetFilters} startIcon={<Icon>restart_alt</Icon>}>
              Reset
            </Button>
          </Grid>
        </Grid>
      </Paper>

      {/* KPI cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="Total Tokens" icon="token" accent={ACCENTS.tokens}
            value={summary ? fmtInt(summary.totalTokens) : '—'} sub="Input + output" />
        </Grid>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="Input (Prompt)" icon="input" accent={ACCENTS.prompt}
            value={summary ? fmtInt(summary.totalPromptTokens) : '—'} sub="Context & prompts" />
        </Grid>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="Output (Completion)" icon="output" accent={ACCENTS.completion}
            value={summary ? fmtInt(summary.totalCompletionTokens) : '—'} sub="Generated content" />
        </Grid>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="Est. Cost (USD)" icon="attach_money" accent={ACCENTS.cost}
            value={summary ? fmtCostTotal(summary.totalCostUsd) : '—'}
            sub={coverage.unpricedTurns ? `${coverage.unpricedTurns} unpriced turn(s)` : 'Priced turns only'} />
        </Grid>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="AI Turns" icon="smart_toy" accent={ACCENTS.turns}
            value={summary ? fmtInt(summary.totalRequests) : '—'} sub="Executed turns" />
        </Grid>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="Avg Latency" icon="speed" accent={ACCENTS.latency}
            value={summary && summary.avgDurationMs !== null ? `${Math.round(toNumber(summary.avgDurationMs))} ms` : summary ? '—' : '—'}
            sub="Turn duration" />
        </Grid>
        <Grid item xs={12} sm={6} md={3} lg={2}>
          <KpiCard R={React} M={MaterialCore} label="Error Rate" icon="error_outline" accent={ACCENTS.errors}
            value={summary ? `${(toNumber(summary.errorRate) * 100).toFixed(1)}%` : '—'}
            sub={summary ? `${fmtInt(summary.errorCount)} failed turn(s)` : 'Failed turns share'} />
        </Grid>
      </Grid>

      {/* Quota / budget (self-scoped views) */}
      {scopedUserId && budget ? (
        <Paper variant="outlined" sx={{ p: 2, mb: 3, borderRadius: '14px' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              AI Quota
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Chip size="small" color={userStatus.allowed ? 'success' : 'error'} label={userStatus.status || 'UNKNOWN'} />
              {userStatus.reason ? <Chip size="small" variant="outlined" label={userStatus.reason} /> : null}
              {budget.hardStop ? <Chip size="small" color="warning" label="Hard stop" /> : null}
            </Box>
          </Box>
          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Typography variant="caption" color="text.secondary">
                Month-to-date tokens
              </Typography>
              <Typography variant="body1" sx={{ fontFamily: 'monospace', mb: 0.5 }}>
                {fmtInt(budget.currentMonthTokens)}
                {budget.monthlyTokenLimit ? ` / ${fmtInt(budget.monthlyTokenLimit)}` : ' / —'}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={budget.monthlyTokenLimit ? pct(budget.currentMonthTokens, budget.monthlyTokenLimit) : 0}
                sx={{ height: 8, borderRadius: 4 }}
              />
            </Grid>
            <Grid item xs={12} md={6}>
              <Typography variant="caption" color="text.secondary">
                Month-to-date cost
              </Typography>
              <Typography variant="body1" sx={{ fontFamily: 'monospace', mb: 0.5 }}>
                {fmtUsd(budget.currentMonthCostUsd)}
                {budget.monthlyCostLimitUsd ? ` / ${fmtUsd(budget.monthlyCostLimitUsd)}` : ' / —'}
              </Typography>
              <LinearProgress
                variant="determinate"
                color="secondary"
                value={budget.monthlyCostLimitUsd ? pct(budget.currentMonthCostUsd, budget.monthlyCostLimitUsd) : 0}
                sx={{ height: 8, borderRadius: 4 }}
              />
            </Grid>
          </Grid>
        </Paper>
      ) : null}

      {!loading && summary && !hasAnyData ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          No AI usage was recorded for the selected window. Totals below are genuinely zero — nothing was fabricated to fill the view.
        </Alert>
      ) : null}

      {/* Charts */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} lg={8}>
          <SectionCard R={React} M={MaterialCore} title="Daily Token Consumption"
            subtitle="Total, prompt and completion tokens over the selected window">
            {isRealComponent(LineChart) && trendData.length > 0 ? (
              <LineChart
                data={trendData}
                xAxisKey="date"
                height={320}
                series={[
                  { dataKey: 'totalTokens', name: 'Total Tokens', stroke: ACCENTS.tokens, type: 'monotone', strokeWidth: 3 },
                  { dataKey: 'promptTokens', name: 'Prompt Tokens', stroke: ACCENTS.prompt, type: 'monotone', strokeWidth: 2 },
                  { dataKey: 'completionTokens', name: 'Output Tokens', stroke: ACCENTS.completion, type: 'monotone', strokeWidth: 2 },
                ]}
                showLegend={true}
                showGrid={true}
              />
            ) : (
              <UsageTable
                R={React}
                M={MaterialCore}
                maxHeight={300}
                rows={trendData}
                columns={[
                  { title: 'Date', field: 'date' },
                  { title: 'Total', field: 'totalTokens', align: 'right', render: (r: any) => fmtInt(r.totalTokens) },
                  { title: 'Prompt', field: 'promptTokens', align: 'right', render: (r: any) => fmtInt(r.promptTokens) },
                  { title: 'Output', field: 'completionTokens', align: 'right', render: (r: any) => fmtInt(r.completionTokens) },
                ]}
              />
            )}
          </SectionCard>
        </Grid>

        <Grid item xs={12} lg={4}>
          <SectionCard R={React} M={MaterialCore} title="Turns & Failures"
            subtitle="Volume beside failures — a failing provider is often a degraded one">
            {isRealComponent(BarChart) && usageData.length > 0 ? (
              <BarChart
                data={usageData}
                xAxisKey="date"
                height={320}
                bars={[
                  { dataKey: 'requests', name: 'Turns', fill: ACCENTS.turns },
                  { dataKey: 'failures', name: 'Failures', fill: ACCENTS.errors },
                ]}
                showLegend={true}
                showGrid={true}
              />
            ) : (
              <UsageTable
                R={React}
                M={MaterialCore}
                maxHeight={300}
                rows={usageData}
                columns={[
                  { title: 'Date', field: 'date' },
                  { title: 'Turns', field: 'requests', align: 'right', render: (r: any) => fmtInt(r.requests) },
                  { title: 'Failures', field: 'failures', align: 'right', render: (r: any) => fmtInt(r.failures) },
                ]}
              />
            )}
          </SectionCard>
        </Grid>
      </Grid>

      {/* Model + provider breakdown */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <SectionCard R={React} M={MaterialCore} title="Token Usage by Model" subtitle="Usage, cost and turns per model">
            <UsageTable
              R={React}
              M={MaterialCore}
              rows={modelRows}
              columns={[
                { title: 'Model', field: 'model', sx: { fontWeight: 600 } },
                { title: 'Provider', field: 'provider', render: (r: any) => (r.provider ? String(r.provider).toUpperCase() : '—'), sx: { opacity: 0.85 } },
                { title: 'Tokens', field: 'totalTokens', align: 'right', render: (r: any) => fmtInt(r.totalTokens), sx: { fontFamily: 'monospace' } },
                { title: 'Cost', field: 'costUsd', align: 'right', render: (r: any) => fmtCostRow(r.costUsd), sx: { fontFamily: 'monospace', color: ACCENTS.cost } },
                { title: 'Turns', field: 'requests', align: 'right', render: (r: any) => fmtInt(r.requests), sx: { fontFamily: 'monospace' } },
              ]}
            />
          </SectionCard>
        </Grid>
        <Grid item xs={12} md={6}>
          <SectionCard R={React} M={MaterialCore} title="Usage by Provider" subtitle="Aggregate usage and spend per AI provider">
            <UsageTable
              R={React}
              M={MaterialCore}
              rows={providerRows}
              columns={[
                { title: 'Provider', field: 'provider', render: (r: any) => (r.provider ? String(r.provider).toUpperCase() : '—'), sx: { fontWeight: 600 } },
                { title: 'Tokens', field: 'totalTokens', align: 'right', render: (r: any) => fmtInt(r.totalTokens), sx: { fontFamily: 'monospace' } },
                { title: 'Cost', field: 'costUsd', align: 'right', render: (r: any) => fmtCostRow(r.costUsd), sx: { fontFamily: 'monospace', color: ACCENTS.cost } },
                { title: 'Turns', field: 'requests', align: 'right', render: (r: any) => fmtInt(r.requests), sx: { fontFamily: 'monospace' } },
              ]}
            />
          </SectionCard>
        </Grid>
      </Grid>

      {/* Failures */}
      {failureRows.length > 0 ? (
        <Grid container spacing={3} sx={{ mb: 3 }}>
          <Grid item xs={12}>
            <SectionCard R={React} M={MaterialCore} title="Failures by Provider & Model"
              subtitle="Where to look, not just how many failed">
              <UsageTable
                R={React}
                M={MaterialCore}
                rows={failureRows}
                columns={[
                  { title: 'Provider', field: 'provider', render: (r: any) => (r.provider ? String(r.provider).toUpperCase() : '—') },
                  { title: 'Model', field: 'model', sx: { fontWeight: 600 } },
                  { title: 'Failures', field: 'failures', align: 'right', render: (r: any) => fmtInt(r.failures), sx: { fontFamily: 'monospace', color: ACCENTS.errors } },
                  { title: 'Retryable', field: 'retryableFailures', align: 'right', render: (r: any) => fmtInt(r.retryableFailures), sx: { fontFamily: 'monospace' } },
                  { title: 'Attempts', field: 'totalAttempts', align: 'right', render: (r: any) => fmtInt(r.totalAttempts), sx: { fontFamily: 'monospace' } },
                  { title: 'Last code', field: 'lastErrorCode', render: (r: any) => r.lastErrorCode || '—' },
                  { title: 'Last message', field: 'lastErrorMessage', render: (r: any) => r.lastErrorMessage || '—', sx: { maxWidth: 320, whiteSpace: 'normal' } },
                ]}
              />
            </SectionCard>
          </Grid>
        </Grid>
      ) : null}

      {/* Per-user breakdown */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12}>
          <SectionCard R={React} M={MaterialCore} title="Token Usage by User"
            subtitle="Consumption per user for the selected window — also what a multi-user selection reports into">
            <UsageTable
              R={React}
              M={MaterialCore}
              maxHeight={420}
              rows={userRows}
              columns={[
                { title: 'User', render: (r: any) => userLabel(r), sx: { minWidth: 220, fontWeight: 600 } },
                { title: 'User ID', field: 'userId', render: (r: any) => r.userId || '—', sx: { fontFamily: 'monospace', fontSize: '0.8rem', opacity: 0.8 } },
                { title: 'Tokens', field: 'totalTokens', align: 'right', render: (r: any) => fmtInt(r.totalTokens), sx: { fontFamily: 'monospace' } },
                { title: 'Cost', field: 'costUsd', align: 'right', render: (r: any) => fmtCostRow(r.costUsd), sx: { fontFamily: 'monospace', color: ACCENTS.cost } },
                { title: 'Turns', field: 'requests', align: 'right', render: (r: any) => fmtInt(r.requests), sx: { fontFamily: 'monospace' } },
              ]}
            />
          </SectionCard>
        </Grid>
      </Grid>

      {/* Coverage */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12}>
          <SectionCard R={React} M={MaterialCore} title="Data Coverage"
            subtitle="How much of the requested window these figures actually cover — a total over 80% of turns is a different claim from all of them">
            <Grid container spacing={2}>
              {[
                { label: 'Attributed', part: coverage.attributedTurns },
                { label: 'Priced', part: coverage.pricedTurns },
                { label: 'Estimated tokens', part: coverage.estimatedTurns },
                { label: 'Unpriced (excluded from cost)', part: coverage.unpricedTurns },
              ].map((c) => (
                <Grid item xs={12} sm={6} md={3} key={c.label}>
                  <Typography variant="caption" color="text.secondary">
                    {c.label}
                  </Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', mb: 0.5 }}>
                    {fmtInt(c.part)} / {fmtInt(coverage.turns)} ({pct(c.part, coverage.turns)}%)
                  </Typography>
                  <LinearProgress variant="determinate" value={pct(c.part, coverage.turns)} sx={{ height: 6, borderRadius: 3 }} />
                </Grid>
              ))}
            </Grid>
            {coverageWarnings.length > 0 ? (
              <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {coverageWarnings.map((w) => (
                  <Chip key={w} size="small" color="warning" variant="outlined" label={w} />
                ))}
              </Box>
            ) : null}
          </SectionCard>
        </Grid>
      </Grid>

      {/* Ledger */}
      <SectionCard
        R={React}
        M={MaterialCore}
        title="Recent AI Activity Ledger"
        subtitle={ledger ? `${fmtInt(ledger.total)} record(s) match the current filters` : 'Chronological AI model interactions'}
        action={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              select
              size="small"
              label="Rows"
              value={ledgerPageSize}
              onChange={(e: any) => {
                setLedgerPageSize(Number(e.target.value));
                setLedgerPage(1);
              }}
              sx={{ width: 100 }}
            >
              {[10, 25, 50].map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </TextField>
            <Button
              size="small"
              variant="outlined"
              disabled={ledgerPage <= 1 || loading}
              onClick={() => setLedgerPage((p) => Math.max(1, p - 1))}
              startIcon={<Icon>chevron_left</Icon>}
            >
              Prev
            </Button>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {ledgerPage}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              disabled={!ledger || !ledger.hasNext || loading}
              onClick={() => setLedgerPage((p) => p + 1)}
              endIcon={<Icon>chevron_right</Icon>}
            >
              Next
            </Button>
          </Box>
        }
      >
        <UsageTable
          R={React}
          M={MaterialCore}
          maxHeight={520}
          rows={(ledger && ledger.records) || []}
          columns={[
            { title: 'Timestamp', render: (r: any) => (r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'), sx: { whiteSpace: 'nowrap' } },
            { title: 'User', render: (r: any) => userLabel(r.user || { userId: r.userId }) },
            { title: 'Persona', field: 'personaId', render: (r: any) => r.personaId || '—' },
            { title: 'Provider', field: 'provider', render: (r: any) => (r.provider ? String(r.provider).toUpperCase() : '—') },
            { title: 'Model', field: 'model', render: (r: any) => r.model || '—' },
            { title: 'Prompt', field: 'promptTokens', align: 'right', render: (r: any) => fmtInt(r.promptTokens), sx: { fontFamily: 'monospace' } },
            { title: 'Output', field: 'completionTokens', align: 'right', render: (r: any) => fmtInt(r.completionTokens), sx: { fontFamily: 'monospace' } },
            { title: 'Total', field: 'totalTokens', align: 'right', render: (r: any) => fmtInt(r.totalTokens), sx: { fontFamily: 'monospace', fontWeight: 600 } },
            { title: 'Cost', field: 'costUsd', align: 'right', render: (r: any) => fmtCostRow(r.costUsd), sx: { fontFamily: 'monospace', color: ACCENTS.cost } },
            { title: 'Latency', field: 'durationMs', align: 'right', render: (r: any) => (r.durationMs !== null && r.durationMs !== undefined ? `${fmtInt(r.durationMs)} ms` : '—'), sx: { fontFamily: 'monospace' } },
            {
              title: 'Source',
              field: 'usageSource',
              render: (r: any) =>
                r.usageSource && r.usageSource !== 'provider'
                  ? <Chip size="small" variant="outlined" color="warning" label={String(r.usageSource).toUpperCase()} />
                  : <Typography variant="caption" color="text.secondary">measured</Typography>,
            },
            {
              title: 'Status',
              field: 'status',
              render: (r: any) => (
                <Chip
                  size="small"
                  color={isFailureStatus(r.status) ? 'error' : 'success'}
                  variant={isFailureStatus(r.status) ? 'filled' : 'outlined'}
                  label={String(r.status || 'ok').toUpperCase()}
                />
              ),
            },
          ]}
        />
        {ledger && ledger.total > 0 ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Page {ledger.page} · {fmtInt(ledger.records.length)} of {fmtInt(ledger.total)} records
          </Typography>
        ) : null}
      </SectionCard>

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary">
        Derived from the conversation message log. Unpriced models are excluded from cost (never counted as free); coverage above makes that explicit.
      </Typography>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

const Definition: any = {
  name: 'UsageDashboardWidget',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: UsageDashboardWidget,
  roles: ['USER', 'ADMIN', 'SUPERADMIN', 'DEVELOPER', 'SYSADMIN'],
};

//@ts-ignore
if (typeof window !== 'undefined' && window.reactory && window.reactory.api) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    UsageDashboardWidget,
    ['AI Usage', 'Dashboard', 'Telemetry', 'Tokens', 'Reactor'],
    Definition.roles,
    true,
    [],
    'widget',
  );
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: UsageDashboardWidget,
  });
}

export default UsageDashboardWidget;
