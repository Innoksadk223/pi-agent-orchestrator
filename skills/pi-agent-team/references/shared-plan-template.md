# agent_team Plan Template

作为一次 `agent_team {action:"plan"}` USER_GATE 的紧凑输入清单使用。TeamState 为唯一权威事实源；`leader/plan.md` 仅作为恢复视图生成。

```json
{
  "action": "plan",
  "team": "<team-id>",
  "plan": {
    "members": [
      {
        "id": "coder",
        "kind": "coder",
        "role": "后端实现工程师",
        "instructions": "你是本团队的资深后端工程师，专精 TypeScript 与 Node 运行时。职责：只实现 TaskPacket 内 owned paths 的改动，动手前先读调用方。边界：不碰他人文件、不做架构决策。风格：代码优先、行文极简。需求模糊时返回 BLOCK 并附问题，不猜测。结尾按约定输出执行 JSON envelope。"
      },
      {
        "id": "reviewer",
        "kind": "reviewer",
        "role": "独立评审",
        "instructions": "你是团队的独立质量门：怀疑一切、只认证据，仅对判定结果负责。边界：只读，绝不编辑文件。风格：严格对照任务 acceptance 逐条核验。通过 review envelope 输出判定；FIX_REQUIRED 必须附可执行的 fix_prompt。",
        "tools": ["read", "grep", "find", "ls"]
      }
    ],
    "reviewerId": "reviewer",
    "tasks": [
      {
        "id": "implementation",
        "memberId": "coder",
        "objective": "<可观察结果>",
        "constraints": ["<范围或禁止事项>"],
        "dependsOn": [],
        "ownedPaths": ["src/concrete-path"],
        "acceptance": ["<二元判定条件>"],
        "relevantPaths": ["src/concrete-path/index.ts"]
      }
    ],
    "acceptance": ["FINAL_VERIFY 证据完整齐备", "用户执行 HUMAN_ACCEPT"]
  }
}
```

修订时重发完整计划并附上：

```json
{"expectedRevision": 1}
```

调用前检查：

- ID 全局唯一；reviewerId 指向某名 `reviewer` 成员；每个 ExecutionTask 的 owner 都是 `coder`。
- DAG 依赖真实存在且无环。
- ownedPaths 是具体的 cwd 相对路径，绝不使用绝对路径、`..` 或 glob 通配符。
- 未排依赖的任务之间不得存在相同或父子包含关系的 owned-path 冲突。
- Roster、TaskPackets、ownership 与 acceptance 必须足够完整，后续轮次只需 ID 和增量即可推进。
- 可选的 debugger/product/optimizer 成员要么现在预先批准，要么日后通过 amendment 追加。
- 不要放入完整全局正文、机密信息、成员聊天指令或历史输出。
- 每个成员的 `instructions` 都是一份专门的专业角色书（职责、边界、风格、输出要求），并用简体中文书写——绝不能是一句话敷衍。
