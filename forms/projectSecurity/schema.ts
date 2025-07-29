const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    securityContact: {
      type: 'object',
      title: 'Security Contact',
      description: 'The primary security contact for this project',
      properties: {
        id: { type: 'string', title: 'User ID' },
        firstName: { type: 'string', title: 'First Name' },
        lastName: { type: 'string', title: 'Last Name' },
        email: { type: 'string', title: 'Email' },
        avatar: { type: 'string', title: 'Avatar URL', format: 'uri' }
      }
    },
    complianceTags: {
      type: 'array',
      title: 'Compliance Tags',
      description: 'Compliance standards this project adheres to',
      items: { 
        type: 'string',
        enum: [
          'GDPR',
          'SOX',
          'PCI-DSS',
          'HIPAA',
          'ISO-27001',
          'SOC-2',
          'NIST',
          'CIS',
          'OWASP',
          'CUSTOM'
        ]
      }
    },
    riskLevel: {
      type: 'string',
      title: 'Risk Level',
      description: 'Overall security risk level for this project',
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      default: 'MEDIUM'
    },
    dataClassification: {
      type: 'string',
      title: 'Data Classification',
      description: 'Classification level of data handled by this project',
      enum: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'CLASSIFIED'],
      default: 'INTERNAL'
    },
    vulnerabilityStatus: {
      type: 'string',
      title: 'Vulnerability Status',
      description: 'Current vulnerability assessment status',
      enum: ['CLEAN', 'LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK', 'CRITICAL', 'UNKNOWN'],
      default: 'UNKNOWN'
    },
    lastSecurityReview: {
      type: 'string',
      title: 'Last Security Review',
      description: 'Date of the last security review',
      format: 'date-time'
    },
    securityNotes: {
      type: 'string',
      title: 'Security Notes',
      description: 'Additional security notes and observations',
      format: 'textarea'
    },
    securityPoliciesUrl: {
      type: 'string',
      title: 'Security Policies URL',
      description: 'Link to security policies documentation',
      format: 'uri'
    },
    encryptionAtRest: {
      type: 'boolean',
      title: 'Encryption at Rest',
      description: 'Whether data is encrypted at rest'
    },
    encryptionInTransit: {
      type: 'boolean',
      title: 'Encryption in Transit',
      description: 'Whether data is encrypted in transit'
    },
    dependenciesWithKnownVulnerabilities: {
      type: 'integer',
      title: 'Dependencies with Known Vulnerabilities',
      description: 'Number of dependencies with known security vulnerabilities',
      minimum: 0
    },
    vulnerabilityReportUrl: {
      type: 'string',
      title: 'Vulnerability Report URL',
      description: 'Link to the latest vulnerability assessment report',
      format: 'uri'
    }
  }
};

export default schema; 