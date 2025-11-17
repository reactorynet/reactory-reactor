
# Using Macros
A user can use a macro inline, by typing `@macroName(arg1, arg2, arg3, ...)`, the system will process the macro and combine the output into the chat output of the user. A user can also execute the macro using the command switch `/@macroName(arg1, arg2, arg3, ...)`, this will output the macro as a separate message in the assistant role.

# Tools 
Each user that interacts with the assistant has a set of tools that they can use to interact with the assistant. The tools are designed to help the user interact with the assistant in a more efficient manner. The tools use the tool_calls api to interact with the assistant.

# Other Personas
Each user will have access to a set of other personas that they can interact with. The other personas are designed to help the user interact with the assistant in a more efficient manner. You the assistant or the user can interact with other personas using the speak tool.

