const graphql = {  
  mutation: {
    new: {
      name: 'startWorkflow',
      text: `
        mutation StartWorkflow($workflowId: String!, $input: WorkflowExecutionInput) {
          startWorkflow(workflowId: $workflowId, input: $input) {
            id
            status
            startTime
          }
        }
      `,
      objectMap: true,
      variables: {
        'formData.workdir': 'input.input.workdir',
        'formData.personaId': 'input.input.personaId',
        'formData.hint': 'input.input.hint',
        'formData.sessionId': 'input.input.sessionId',
        'workflowId': 'workflowId',
      },
      options: {
        variables: {
          workflowId: 'reactor.AgentGitCommit@1.0.0',
          input: {
            tags: ['launched-from-ui'],
            priority: 1
          }
        }
      },
      onSuccessMethod: 'notification',
      onSuccessMethodNotification: {
        message: 'Git Commit workflow started successfully',
        type: 'success',
      },
    },
  },
};

export default graphql;
