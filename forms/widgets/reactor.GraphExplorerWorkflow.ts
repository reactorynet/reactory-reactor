
const GraphExplorerWorkflow = (props: { reactory: Reactory.Client.ReactorySDK }) => {

  const { reactory } = props;

  // handles the query errors
  const handleQueryError = (error: any) => { 
    reactory.log(`Some shit went down dawg!`);
  }

  const handleMutationError = (error: any) => {

  }

  const deleteNode = (node: any) => { 

  }

  const addNew = () => {

  }

  const updateNode = (node: any) => {

  }

  return {
    handleQueryError,
    handleMutationError,
    deleteNode,
    addNew,
    updateNode
  }
}


const Definition: Reactory.Client.IReactoryComponentRegistryEntry<any> = {
  name: 'GraphExplorerWorkflow',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: null,
  roles: ['USER'],
  componentType: 'workflow'
}

//@ts-ignore
if (window && window.reactory) {
  //@ts-ignore
  const reactory: Reactory.Client.ReactorySDK = window.reactory.api as Reactory.Client.ReactorySDK

  let instance: any = null;
  const getComponent = () => {
    if(instance === null) instance = GraphExplorerWorkflow({ reactory });
    return instance;
  }

  reactory.registerComponent(Definition.nameSpace,
    Definition.name,
    Definition.version,
    getComponent,
    ['Support Ticket'],
    Definition.roles,
    false,
    [],
    "workflow");
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', { componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`, component: getComponent });
}