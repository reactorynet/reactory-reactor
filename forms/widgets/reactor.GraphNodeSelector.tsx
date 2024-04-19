import { JsxElement } from "typescript"


interface IProps {
  reactory: Reactory.Client.ReactorySDK,
  formData: any,
  uiSchema: Reactory.Schema.IUISchema,
  formContext: Reactory.Forms.ReactoryFormContext<any, any>,  
}

export default ({ reactory }: IProps) => {
  const {
    React,
    FullScreenModal,
    Material
  } = reactory.getComponents<{
    React: Reactory.React,
    FullScreenModal: JsxElement,
    Material: Reactory.Client.Web.IMaterialModule
  }>(["core.FullScreenModal", "material-ui.Material", "react.React"])


  const {
    Button,
    IconButton
  } = Material.MaterialCore;

  const {
    Edit
  } = Material.MaterialIcons;
  
  return (
    <>
      <IconButton>
        <Edit />
      </IconButton>
    </>
  )
}