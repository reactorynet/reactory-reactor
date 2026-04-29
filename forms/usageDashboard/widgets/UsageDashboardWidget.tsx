'use strict';

interface IUsageDashboardWidgetProps {
  reactory: any;
  formData: any;
  uiSchema: any;
  formContext: any;
}

const UsageDashboardWidget = (props: IUsageDashboardWidgetProps) => {
  const { reactory, formData, formContext } = props;

  const { Material, React } = reactory.getComponents([
    'material-ui.Material',
    'react.React',
  ]);

  const {
    Card,
    CardContent,
    CardHeader,
    LinearProgress,
    Typography,
    Box,
    Chip,
    Stack,
    Divider,
    Alert,
  } = Material.MaterialCore;

  const { useState, useEffect } = React;

  const userId =
    formData?.userId ||
    formContext?.props?.userId ||
    formContext?.user?._id ||
    null;

  const [budgetCheck, setBudgetCheck] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const query = `query ReactorBudgetCheck($userId: ObjID!) {
      ReactorBudgetCheck(userId: $userId) {
        status
        periods {
          period
          usedUsdCents
          limitUsdCents
          pctUsed
          softThresholdPct
          breachedHard
          breachedSoft
        }
      }
    }`;

    reactory.api
      .graphqlQuery(query, { userId })
      .then((result: any) => {
        if (cancelled) return;
        if (result?.errors?.length) {
          setError(result.errors[0].message || 'Failed to load budget');
        } else {
          setBudgetCheck(result?.data?.ReactorBudgetCheck);
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load budget');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const formatUsd = (cents: number) => {
    if (cents == null) return '–';
    if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
    return `${cents.toFixed(2)}¢`;
  };

  const statusChip = (status: string) => {
    if (status === 'no-budget') return <Chip size="small" label="No budget set" />;
    if (status === 'ok') return <Chip size="small" label="OK" color="success" />;
    if (status === 'soft-warn') return <Chip size="small" label="Approaching limit" color="warning" />;
    if (status === 'hard-block') return <Chip size="small" label="Over limit" color="error" />;
    return <Chip size="small" label={status} />;
  };

  const progressColor = (period: any) => {
    if (period.breachedHard) return 'error';
    if (period.breachedSoft) return 'warning';
    return 'primary';
  };

  if (!userId) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography variant="body2" color="text.secondary">
            No user context — pass <code>userId</code> via formData or formContext.props.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card variant="outlined">
        <CardContent>
          <LinearProgress />
          <Typography variant="caption">Loading usage…</Typography>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Alert severity="error">{error}</Alert>
        </CardContent>
      </Card>
    );
  }

  if (!budgetCheck) {
    return null;
  }

  return (
    <Card variant="outlined">
      <CardHeader
        title="AI Usage"
        subheader="Spend vs budget for the current period"
        action={statusChip(budgetCheck.status)}
      />
      <CardContent>
        {budgetCheck.status === 'no-budget' && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This user has not opted into budgeting. AI usage is unrestricted.
          </Alert>
        )}
        <Stack spacing={2} divider={<Divider flexItem />}>
          {(budgetCheck.periods || []).map((p: any) => (
            <Box key={p.period}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle2" sx={{ textTransform: 'capitalize' }}>
                  {p.period}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatUsd(p.usedUsdCents)} / {formatUsd(p.limitUsdCents)}
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={Math.min(p.pctUsed, 100)}
                color={progressColor(p)}
                sx={{ mt: 1, height: 8, borderRadius: 4 }}
              />
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {p.pctUsed.toFixed(1)}% used
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Soft threshold {p.softThresholdPct}%
                </Typography>
              </Stack>
            </Box>
          ))}
          {(!budgetCheck.periods || budgetCheck.periods.length === 0) && (
            <Typography variant="body2" color="text.secondary">
              No periods configured.
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
};

const Definition = {
  name: 'UsageDashboardWidget',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: UsageDashboardWidget,
  roles: ['USER'],
  tags: ['user', 'usage', 'budget'],
};

//@ts-ignore
if (typeof window !== 'undefined' && window.reactory) {
  //@ts-ignore
  window.reactory.api.registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    UsageDashboardWidget,
    Definition.tags,
    Definition.roles,
    true,
  );
}

export default UsageDashboardWidget;
