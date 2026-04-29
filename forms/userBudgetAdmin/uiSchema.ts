import Reactory from '@reactorynet/reactory-core';

const UserSelectQuery: Reactory.Forms.IReactoryFormQuery = {
  name: 'ReactoryUsers',
  text: `query ReactoryUsers($filter: ReactoryUserFilterInput, $paging: PagingRequest) {
    ReactoryUsers(filter: $filter, paging: $paging) {
      users {
        id
        firstName
        lastName
        email
      }
      paging {
        page
        pageSize
        total
        hasNext
      }
    }
  }`,
  variables: {
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
    'filter.searchString': 'filter.searchString',
  },
  resultMap: {
    'users[].id': ['[].key', '[].id', '[].value'],
    'users[].firstName': '[].firstName',
    'users[].lastName': '[].lastName',
    'users[].email': '[].email',
  },
  props: {
    paging: { page: 1, pageSize: 100 },
    filter: { searchString: '' },
  },
};

const periodLayout = {
  enabled: { size: { xs: 12, sm: 3, md: 2 } },
  limitUsdCents: { size: { xs: 12, sm: 3, md: 4 } },
  softThresholdPct: { size: { xs: 12, sm: 3, md: 3 } },
  hardBlock: { size: { xs: 12, sm: 3, md: 3 } },
};

const periodUI = {
  'ui:field': 'GridLayout',
  'ui:grid-layout': [periodLayout],
  enabled: { 'ui:widget': 'checkbox' },
  hardBlock: { 'ui:widget': 'checkbox' },
};

const uiSchema: Reactory.Schema.IFormUISchema = {
  'ui:form': {
    componentType: 'div',
    showSubmit: true,
    showRefresh: true,
    submitProps: {
      variant: 'contained',
      color: 'primary',
      title: 'Save budget',
    },
  },
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    {
      userId: { size: { xs: 12, md: 8 } },
      active: { size: { xs: 12, md: 4 } },
      timezone: { size: { xs: 12, md: 6 } },
      weekStartsOn: { size: { xs: 12, md: 6 } },
      day: { size: { xs: 12 } },
      week: { size: { xs: 12 } },
      month: { size: { xs: 12 } },
      scope: { size: { xs: 12 } },
      pricingOverrides: { size: { xs: 12 } },
    },
  ],
  userId: {
    'ui:widget': 'SelectWithDataWidget',
    'ui:graphql': UserSelectQuery,
    'ui:options': {
      placeholder: 'Search and select a user',
      remoteData: true,
      query: 'ReactoryUsers',
      labelFormat: '${option.firstName} ${option.lastName} (${option.email})',
      valueKey: 'id',
      labelKey: 'email',
    },
  },
  active: {
    'ui:widget': 'checkbox',
  },
  timezone: {
    'ui:placeholder': 'UTC',
    'ui:help': 'IANA timezone identifier — e.g. UTC, Africa/Johannesburg, America/New_York',
  },
  weekStartsOn: {
    'ui:widget': 'SelectWidget',
    'ui:options': {
      selectOptions: [
        { value: 'mon', label: 'Monday' },
        { value: 'sun', label: 'Sunday' },
      ],
    },
  },
  day: {
    'ui:title': 'Day budget',
    ...periodUI,
  },
  week: {
    'ui:title': 'Week budget',
    ...periodUI,
  },
  month: {
    'ui:title': 'Month budget',
    ...periodUI,
  },
  scope: {
    'ui:field': 'GridLayout',
    'ui:grid-layout': [
      {
        providerIds: { size: { xs: 12, md: 6 } },
        modelIds: { size: { xs: 12, md: 6 } },
      },
    ],
    providerIds: {
      'ui:options': {
        addable: true,
        orderable: false,
      },
    },
    modelIds: {
      'ui:options': {
        addable: true,
        orderable: false,
      },
    },
  },
  pricingOverrides: {
    'ui:options': {
      addable: true,
      orderable: false,
      removable: true,
    },
  },
};

export default uiSchema;
