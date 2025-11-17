const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {        
    name: 'ReactorProjectByName',
    text: `
      query ReactorProject($name: String!) {
        ReactorProjectByName(name: $name) {
          id
          name
          nameSpace
          version
          security {
            securityContact {
              id
              firstName
              lastName
              email
              avatar
            }
            complianceTags
            riskLevel
            dataClassification
            vulnerabilityStatus
            lastSecurityReview
            securityNotes
            securityPoliciesUrl
            encryptionAtRest
            encryptionInTransit
            dependenciesWithKnownVulnerabilities
            vulnerabilityReportUrl
          }
        }
      }`,
      variables: { 
        'props.serviceId': 'name',
      },
      resultType: 'object',
      resultMap: { 
        'id': 'id',
        'name': 'name',
        'nameSpace': 'nameSpace',
        'version': 'version',
        'securityContact': 'securityContact',
        'complianceTags': 'complianceTags',
        'riskLevel': 'riskLevel',
        'dataClassification': 'dataClassification',
        'vulnerabilityStatus': 'vulnerabilityStatus',
        'lastSecurityReview': 'lastSecurityReview',
        'securityNotes': 'securityNotes',
        'securityPoliciesUrl': 'securityPoliciesUrl',
        'encryptionAtRest': 'encryptionAtRest',
        'encryptionInTransit': 'encryptionInTransit',
        'dependenciesWithKnownVulnerabilities': 'dependenciesWithKnownVulnerabilities',
        'vulnerabilityReportUrl': 'vulnerabilityReportUrl',
      },
    },
  };

export default graphql; 