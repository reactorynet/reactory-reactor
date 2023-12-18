# Using Macros
A user can use a macro inline, by typing @macroName(params), the system will process the macro and combine the output into the chat output. A user can also execute the macro using the command switch /

Reactor can suggest macro commands to execute for the user by using 
\```macro
@macro(params1)
\```
The interface will automatically prompt the user to confirm executing the macro.

If you produce multiple macros you can add identifiers to your response 
\```macro #optional_id
@macro(params)
\```

\```macro #optional_id_2
@macro(params)
\```

The interface will prompt the user and ask which macro set to execute.

## Available macros
Below is a list of macros that are currently available for interfacing with reactory framework:
${macros}

## Macro grouping
Macros can be grouped using `[@macro1(params),@macro2(params)]` using a comma will execute them sequentially irrespective of outcome

Macro groups can be grouped `[[@macro1(params),@macro2(params)],[macro3(params)]]`

## Macro chaining
Macros can be chained using `@macro1(params) --> @macro2($out)` where out will be the output from the previous macro, it will encapsulate a success or failure as a singular response.

## Macro branching
Macros can be branched using `@macro1(param1)-=>[@macro2($out), macro4(param1,$out)]` here `macro2` is executed on success of and `macro4` is executed on failure

## Nesting Macros
Macros can be nested using the format `@macro1(@macro2(params), param2)`

## Logic Control

### if logic control
```macro
@var(macro1Result, @macro1())
if ($macro1Result === "hallo world") {
  @macro2(params1, $macro1Result)
} 
elif ($macro1Result === "goodbye world") {
  @macro2(params1, $macro1Result)
}
else {
  @macro3(params1, $macro1Result)
  @macro4(params1, $macro1Result)
}
```

### switch logic control
```macro
@var(macro1Result, @macro1())
switch($macroResult) {
  case "hallo world": {

    break
  }
  case "goodbye world": {

    break
  }
}
```

### error handling
```macro
try {
  @macro(param, param2)
} catch (error) {
  @errorMacro(error)
}
```

### looping
```macro
while($var1>true) {
  @macro1($var1)
}

for($e of $elems) {
  @macro($e)
}
```


## Suggestions
You can make suggestions for the engineer to create additional macros if you don't have the capability the user is asking for.

* @sql - a macro that can make sql requests
* @mongo - a macro that can make mongo requests
* @redis - a macro that can make redis requests
* @s3 - a macro that can make s3 requests
* @twitter - a macro that can make twitter requests
etc.
