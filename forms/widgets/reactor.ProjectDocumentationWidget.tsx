import Reactory, { React } from '@reactorynet/reactory-core';
import { ReactorProjectDocumentation } from 'modules/reactory-reactor/types/service.types';

interface ReactorProjectDocumentationWidgetProps { 
 reactory: Reactory.Client.ReactorySDK,
 formData: ReactorProjectDocumentation | null,
 schema: Reactory.Schema.ISchema,
 uiSchema: Reactory.Schema.IUISchema,
 formContext: Reactory.Forms.ReactoryFormContext<any, any>, 
}
type ReactorProjectDocumentationWidget = (props: ReactorProjectDocumentationWidgetProps) => React.ReactElement;

const ProjectDocumentationWidget: ReactorProjectDocumentationWidget = (props) => {
  const { reactory, formData, schema, uiSchema, formContext } = props;
  const { 
   React,
   Material, 
   ContentRender,
  } = reactory.getComponents<{
    React: Reactory.React;
    Material: Reactory.Client.Web.IMaterialModule;
    ContentRender: (props: { content: string, className?: string }) => React.ReactElement;
  }>(["react.React", "material-ui.Material", "core.ContentRender"]);
  
  const {
    id,
    title,
    content,
    url,
    format,
    created,
    createdBy
  } = formData; 

  const { useState, useEffect } = React;
  const { 
    Box, 
    Typography, 
    Paper, 
    Avatar, 
    Divider 
  } = Material.MaterialCore;

  const [contentFormat, setContentFormat] = useState(format || 'markdown');
  const [contentData, setContentData] = useState(content || '');

  useEffect(() => {
    if (content) {
      setContentData(content);
    } else if (url) {
      // Fetch content from URL if available
      fetch(url)
        .then(response => response.text())
        .then(data => setContentData(data))
        .catch(error => console.error('Error fetching documentation content:', error));
    }
  }, [content, url]);

  return (    
    <Box sx={{ padding: 2 }}>      
      <Paper elevation={3} sx={{ padding: 2 }}>
        <Box display="flex" alignItems="center" mb={2}>
          {createdBy && (
            <Avatar src={createdBy.avatar} alt={`${createdBy.firstName} ${createdBy.lastName}`} />
          )}
          <Box ml={2}>
            <Typography variant="h6">{title}</Typography>
            <Typography variant="subtitle1" color="textSecondary">
              Created by {createdBy ? `${createdBy.firstName} ${createdBy.lastName}` : 'Unknown'} on {new Date(created).toLocaleDateString()}
            </Typography>
          </Box>
        </Box>
        <Divider />
        <ContentRender content={contentData} className={`documentation-content ${contentFormat}`} />
      </Paper>
    </Box>
  );
}

const Definition = {
  nameSpace: 'reactor',
  name: 'ProjectDocumentationWidget',
  component: ProjectDocumentationWidget,
  version: '1.0.0',
  roles: ['USER'],
  componentType: 'component'
}

//@ts-ignore
if (window && window.reactory) {
  //@ts-ignore
  (window.reactory.api as Reactory.Client.ReactorySDK).registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    ProjectDocumentationWidget,
    ['ProjectDocumentationWidget', 'ReactorProjectDocumentationWidget'],
    Definition.roles,
    true,
    [],
    'widget');
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', { componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`, component: ReactorGraphExplorer });
}