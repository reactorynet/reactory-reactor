'use strict';

interface IReactorProjectCardProps {
  reactory: any;
  formData: any;
  schema: any;
  uiSchema: any;
  idSchema: any;
  onChange: (formData: any) => void;
}

const ReactorProjectCard = (props: IReactorProjectCardProps) => {
  const { reactory, formData = null, uiSchema, idSchema } = props;

  const {
    Material,
    React,
  } = reactory.getComponents([
    'material-ui.Material',
    'react.React',
  ]);

  const {
    Card,
    CardHeader,
    CardContent,
    CardActions,
    Avatar,
    Typography,
    Button,
    Chip,
  } = Material.MaterialCore;

  if (!formData) return null;

  return (
    <Card sx={{ minWidth: 300, maxWidth: 400, m: 1 }}>
      <CardHeader
        avatar={<Avatar>{formData.name?.[0]}</Avatar>}
        title={formData.name}
        subheader={formData.nameSpace}
      />
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {formData.description}
        </Typography>
        {formData.tags && formData.tags.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {formData.tags.map((tag: string) => (
              <Chip key={tag} label={tag} size="small" sx={{ mr: 0.5 }} />
            ))}
          </div>
        )}
      </CardContent>
      <CardActions>
        <Button size="small" href={formData.repoUrl || '#'} target="_blank">Repo</Button>
        <Button size="small" href={formData.docsUrl || '#'} target="_blank">Docs</Button>
      </CardActions>
    </Card>
  );
};


const Definition = {
  name: 'ReactorProjectCard',
  nameSpace: 'reactor',
  version: '1.0.0',
  component: ReactorProjectCard,
  roles: ['USER'],
  tags: ['user', 'content']
};


//@ts-ignore
if (window && window.reactory) {
  //@ts-ignore
  window.reactory.api.registerComponent(Definition.nameSpace,
    Definition.name,
    Definition.version,
    ReactorProjectCard,
    [''],
    Definition.roles,
    true,
    [],
    'widget');
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', {
    componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`,
    component: ReactorProjectCard
  });
}

export default Definition;