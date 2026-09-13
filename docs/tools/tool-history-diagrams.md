<!--
  Copyright 2026 LC Contributors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

# Tool History — Architecture Diagrams

## 1. Detailed

```mermaid
flowchart TB
    subgraph Turn1["Turn 1"]
        U1["👤 User: read this dir"] --> A1["🤖 Assistant + tool_calls"]
        A1 --> T1["📂 lc_list_dir → 2.5 KB"]
        A1 --> T2["📄 lc_read_file → 27 KB"]
        A1 --> T3["🖼️ lc_read_image → 3 KB"]
        T1 & T2 & T3 --> R1["💬 Reply: here's what I found..."]
    end

    subgraph Turn2["Turn 2"]
        U2["👤 User: now test tools"] --> A2["🤖 Assistant + 10 tool_calls"]
        A2 --> T4["📂📄🔍🖼️ 10 results → 300 KB total"]
        T4 --> R2["💬 Reply: all tests passed!"]
    end

    subgraph Archived["🗄️ Archived (stubs only)"]
        STUB1["⚠️ archived_msg_1 pair<br/>3 results archived<br/>lc_list_dir, lc_read_file, lc_read_image"]
        STUB2["⚠️ archived_msg_2 pair<br/>10 results archived<br/>lc_todo_write, lc_get_current_time..."]
    end

    Turn1 -.->|"turn completes"| Archived
    Turn2 -.->|"turn completes"| Archived

    subgraph NextReq["Next API Request"]
        direction LR
        SYS["⚙️ System prompt<br/>(Workspace + History ON)"]
        STUB1 --> SYS
        STUB2 --> SYS
        U3["👤 User: what about...?"]
    end

    Archived --> NextReq

    subgraph Retrieval["🔍 On-demand retrieval"]
        CALL["Model calls lc_tool_history"]
        KIND{"Resolved lc_whiteboard?"}
        FULL["Ordinary tool:<br/>bounded archived result<br/>+ owning turn refs when present"]
        REFS["Whiteboard:<br/>action + owning refs when present<br/>no historical Markdown"]
    end

    NextReq -->|"model needs context"| CALL
    CALL --> KIND
    KIND -->|"no"| FULL
    KIND -->|"yes"| REFS
    FULL -->|"re-stream with results"| NextReq
    REFS -->|"call lc_whiteboard read<br/>for current boards"| NextReq

    style Archived fill:#1a3a2a,stroke:#2d8a4e,color:#8fdfa8
    style STUB1 fill:#1a3a2a,stroke:#2d8a4e,color:#8fdfa8
    style STUB2 fill:#1a3a2a,stroke:#2d8a4e,color:#8fdfa8
```

## 2. Simplified (mobile)

```mermaid
flowchart TB
    T1["Turn 1: read dir<br/>📂📄🖼️ 32.5 KB"] -->|"done"| S1["🗄️ Stub"]
    T2["Turn 2: test tools<br/>10 results · 300 KB"] -->|"done"| S2["🗄️ Stub"]
    S1 & S2 --> R["📤 Next request<br/>paired archive stubs"]
    R -->|"needs past"| H["🔍 lc_tool_history"]
    H -->|"ordinary: bounded result<br/>Whiteboard: action + refs when present"| S1 & S2

    style S1 fill:#1a3a2a,stroke:#2d8a4e,color:#8fdfa8
    style S2 fill:#1a3a2a,stroke:#2d8a4e,color:#8fdfa8
```

> **Figures in this document are illustrative scenario values**, not
> measurements. Turn 1's 32.5 KB is the sum of its detail rows in §1:
> 2.5 + 27 + 3 KB. Turn 2 uses the scenario from `tool-history.md` §1:
> 10 results × 30 KB per result = 300 KB. The next-request label makes no
> numeric savings claim. If the scenario changes, keep each figure consistent
> with the detailed diagram and feature contract.

The Whiteboard branch is a retrieval privacy boundary, not a storage rewrite.
Canonical local messages and conversation archives retain the original calls
and results. With Tool History off, provider requests also replay those complete
historical Whiteboard exchanges. With Tool History on, archived request turns
use the same generic stubs shown above, and explicit `lc_tool_history`
retrieval returns no board Markdown or mutation payload.
