import { JsxElement } from "typescript"

// Define interfaces for chat data structures
interface ChatMessage {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
}

interface AIModel {
  id: string;
  name: string;
  description?: string;
}

interface IProps {
  reactory: Reactory.Client.ReactorySDK,
  formData: any,
  uiSchema: Reactory.Schema.IUISchema,
  formContext: Reactory.Forms.ReactoryFormContext<any, any>,  
}

export default ({ reactory, formData }: IProps) => {
  const {
    React,    
    Material
  } = reactory.getComponents<{
    React: Reactory.React,    
    Material: Reactory.Client.Web.IMaterialModule
  }>(["core.FullScreenModal", "material-ui.Material", "react.React"])

  const { useState } = React;

  const {
    Button,
    IconButton,
    TextField,
    Grid,
    Typography,
    Box,
    List,
    ListItem,
    Menu,
    MenuItem,
    Paper,
    Avatar,
    Divider
  } = Material.MaterialCore;

  const {
    Edit,
    Send,
    ArrowDropDown,
    SmartToy,
    Person
  } = Material.MaterialIcons;
  
  // Available AI models - in a real implementation, these would come from API
  const [availableModels, setAvailableModels] = useState<AIModel[]>([
    { id: 'gpt-4', name: 'GPT-4 (Advanced)' },
    { id: 'gpt-3.5', name: 'GPT-3.5 (Fast)' },
    { id: 'claude', name: 'Claude' },
    { id: 'gemini', name: 'Gemini Pro' },
    { id: 'grok-2', name: 'Grok 2' },
    { id: 'grok-3', name: 'Grok 3' },
  ]);
  
  // State management
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      text: 'Hello! How can I assist you today?',
      sender: 'bot',
      timestamp: new Date()
    }
  ]);
  const [userInput, setUserInput] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<AIModel>(availableModels[0]);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  
  // Handler functions
  const handleModelMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };
  
  const handleModelMenuClose = () => {
    setAnchorEl(null);
  };
  
  const handleModelSelect = (model: AIModel) => {
    setSelectedModel(model);
    handleModelMenuClose();
  };
  
  const handleSendMessage = () => {
    if (userInput.trim() === '') return;
    
    // Add user message
    const newUserMessage: ChatMessage = {
      id: Date.now().toString(),
      text: userInput,
      sender: 'user',
      timestamp: new Date()
    };
    
    setMessages([...messages, newUserMessage]);
    setUserInput('');
    
    // Simulate AI response (would be an API call in production)
    setTimeout(() => {
      const botMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        text: `This is a response from ${selectedModel.name}. In a real implementation, this would come from the AI model.`,
        sender: 'bot',
        timestamp: new Date()
      };
      
      setMessages(prevMessages => [...prevMessages, botMessage]);
    }, 1000);
  };
  
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  reactory.log('ChatBotWidget - Rendering ChatBotWidget', { formData });
  
  return (
    <Box sx={{ height: '600px', display: 'flex', flexDirection: 'column', maxWidth: 800, mx: 'auto', p: 2 }}>
      {/* Header with model selection */}
      <Paper elevation={2} sx={{ p: 2, mb: 2 }}>
        <Grid container alignItems="center" spacing={2}>
          <Grid item>
            <SmartToy fontSize="large" color="primary" />
          </Grid>
          <Grid item xs>
            <Typography variant="h6">AI Chat Assistant</Typography>
          </Grid>
          <Grid item>
            <Button 
              variant="outlined" 
              onClick={handleModelMenuOpen}
              endIcon={<ArrowDropDown />}
            >
              {selectedModel.name}
            </Button>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={handleModelMenuClose}
            >
              {availableModels.map((model) => (
                <MenuItem 
                  key={model.id} 
                  onClick={() => handleModelSelect(model)}
                  selected={model.id === selectedModel.id}
                >
                  {model.name}
                </MenuItem>
              ))}
            </Menu>
          </Grid>
        </Grid>
      </Paper>
      
      {/* Chat messages list */}
      <Paper 
        elevation={3} 
        sx={{ 
          flexGrow: 1, 
          mb: 2, 
          overflow: 'auto',
          p: 2
        }}
      >
        <List>
          {messages.map((message) => (
            <ListItem
              key={message.id}
              alignItems="flex-start"
              sx={{
                justifyContent: message.sender === 'user' ? 'flex-end' : 'flex-start',
                mb: 2
              }}
            >
              <Paper
                elevation={1}
                sx={{
                  p: 2,
                  maxWidth: '70%',
                  backgroundColor: message.sender === 'user' ? '#e3f2fd' : '#f5f5f5'
                }}
              >
                <Grid container spacing={1}>
                  <Grid item>
                    <Avatar sx={{ bgcolor: message.sender === 'user' ? 'primary.main' : 'secondary.main' }}>
                      {message.sender === 'user' ? <Person /> : <SmartToy />}
                    </Avatar>
                  </Grid>
                  <Grid item xs>
                    <Typography variant="body1">
                      {message.text}
                    </Typography>
                    <Typography variant="caption" color="textSecondary">
                      {message.timestamp.toLocaleTimeString()}
                    </Typography>
                  </Grid>
                </Grid>
              </Paper>
            </ListItem>
          ))}
        </List>
      </Paper>
      
      {/* Input area */}
      <Paper elevation={3} sx={{ p: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs>
            <TextField
              fullWidth
              placeholder="Type your message here..."
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyPress={handleKeyPress}
              multiline
              maxRows={4}
              variant="outlined"
            />
          </Grid>
          <Grid item>
            <Button
              variant="contained"
              color="primary"
              endIcon={<Send />}
              onClick={handleSendMessage}
              disabled={userInput.trim() === ''}
              sx={{ height: '100%' }}
            >
              Send
            </Button>
          </Grid>
        </Grid>
      </Paper>
    </Box>
  );
}