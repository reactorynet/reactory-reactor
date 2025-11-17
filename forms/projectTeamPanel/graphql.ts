const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {
    name: "ReactorProjectByName",
    text: `
      query ReactorProject($name: String!) {
        ReactorProjectByName(name: $name) {
          id
          name
          nameSpace
          version
          owner {
            id
            firstName
            lastName
            email
            avatar
          }
          ownerTeam {
            id
            name
            description
            avatar
          }
          teams {
            id
            name
            description
            avatar
          }
          engineers {
            id
            firstName
            lastName
            email
            avatar
          }
          businessUnit {
            id
            name
            description
          }
          organization {
            id
            name
            description
          }
        }
      }`,
    variables: {
      "props.serviceId": "name",
    },
    resultType: "object",
    resultMap: {
      id: "id",
      name: "name",
      nameSpace: "nameSpace",
      version: "version",
      owner: "owner",
      ownerTeam: "ownerTeam",
      teams: "teams",
      engineers: "engineers",
      businessUnit: "businessUnit",
      organization: "organization",
    },
  },
};

export default graphql;
