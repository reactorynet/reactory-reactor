#Overview
The reactor module is an AI focussed module that integrates AI tools and frameworks in order to extend the Reactory eco system. The module allows for a multitenant, multi bot configuration that has deep context of the system it supports as well as the user execution context.

## Engineer Flow

```mermaid
sequenceDiagram
    participant eng as Engineer (cli / web)
    participant graph as Graph
    participant bot as Reactor Bot
    participant ioc as Reactory IoC Kernal
    participant llm as Trained LLM AI
    participant pred as Cached Models
    Note over eng,ioc: Executes with tenant & user context
    eng->>graph: How can I create a new application with reactory?
    graph->>ioc: get bot service
    ioc->>graph: provides configured bot service    
    Note right of bot: Introspection
    graph->>ioc: Uses NLP Service to reduce / catalog tokens
    ioc->>graph: "create new app"
    graph->>bot: How can I create a new application with reactory?
    bot->>llm: How can I create a new application with reactory?
    llm->>bot: "You can use the @createApp macro"
    bot->>pred: Stores results
    bot->>graph: "You can use the @createApp macro"
    graph->>eng: "You can use the @createApp macro"    
```

## Customer Flow

```mermaid
sequenceDiagram
    participant cust as Customer (native / web)
    participant graph as Graph
    participant bot as Support Bot
    participant engbot as Engineer Bot
    participant dsl as DSL
    participant ioc as Reactory IoC Kernal
    participant llm as Trained LLM AI
    participant pred as Fast AI Models
    Note over cust,ioc: Executes with tenant & user context
    cust->>graph: Why is my transfer that I sent taking so long?
    graph->>ioc: get bot service
    ioc->>graph: provides configured bot service    
    Note right of bot: Introspection
    graph->>ioc: Uses NLP Service to reduce / catalog tokens
    ioc->>graph: "why is my transfer taking long"
    graph->>bot: "Why is my transfer that I sent taking so long?"
    bot->>llm: "Why is my transfer that I sent taking so long?"
    llm->>bot: "use the ```@transferStatus()``` macro to check last transfer"
    bot-->>pred: Stores results
    bot-->>dsl: Executes extracted macro
    dsl-->>bot: returns "Status delayed, error on payment network"
    bot-->>llm: "Status delayed, error on payment network"
    llm-->bot: "Ask to speak with engineer bot, using @chats(speakto, engbot)"
    bot-->dsl: executes macro
    bot-->engbot: "transfer id 1234 experiencing networking error"
    engbot-->llm: "investigate networking error on transfer id"
    llm-->engbot: send multistage DSL script
    engbot-->dsl: executes & collates outpt
    dsl-->engbot: report
    engbot-->llm: "Summarise $report"
    llm-->engbot: Summary
    engbot-->bot: Summary report
    bot-->graph: Summary report
    graph->>cust: "Your transaction is stuck due to..."    
```