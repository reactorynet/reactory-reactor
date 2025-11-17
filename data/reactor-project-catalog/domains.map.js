export default {
  Domain: 'businessUnit.name',
  Squad: 'ownerTeam.name',
  'Slack Channel': [{
    key: 'primarySlack.channel',
    transform: (value) => value
  }],
  'JIRA Project': [{
    key: 'tasksUrl',
    transform: (value) => {
      if (!value) return '';
      if (value.startsWith('https://')) {
        return value;
      }
      if (value.startsWith('http://')) {
        return value;
      }
      return `https://worldremit.atlassian.net/browse/${value}`;
    }
  }],
};
