# LARK API
本项目是把飞书作为ACP的客户端的桥接库，虽然有API SDK调用，但是也不免会涉及到参考飞书官方API文档，必要时候需要参看：https://open.larksuite.com/document/server-docs/getting-started/getting-started

# ACP
ACP（Agent Communication Protocol）参考文档 https://agentcommunicationprotocol.dev/core-concepts/architecture

# TypeScript 工程准则（TypeScript 5.x / Strict Mode）

适用于本仓库所有 TypeScript 代码。AI 助手与人类贡献者都应遵守。

## 1. 避免魔法值

除显而易见的平凡值（`0`、`1`、一天 `24` 小时）外，禁止硬编码未加说明的数字或字符串字面量。

- 使用 `const` 常量，配合 `as const` 收窄字面量类型；或定义字面量 union。
- 优先使用所引入库已暴露的常量；库中确无定义时再自行声明。
- 常量应放在与其语义最贴近的模块中，不要堆到一个全局 `constants.ts`。

## 2. 错误处理：默认抛异常 + 文档化

TS / Node 生态以异常为主，**默认采用抛异常 + JSDoc `@throws` 文档化**的风格，与标准库、绝大多数第三方库保持一致。

- 任何可能抛出（含 `Promise` reject）的函数，必须在 JSDoc 中通过 `@throws` 描述失败原因与错误类型。
- 错误类型用自定义 `Error` 子类区分语义，并带上有用的上下文字段；不要把多种语义不同的错误合并成同一个原始 `Error`。
- 仅在以下**特定边界**才考虑 Result / Either 风格的返回类型（明确"失败是预期分支而非异常"）：
  - schema 校验 / 反序列化（如 `zod` 的 `safeParse`）
  - 用户输入 / 表单校验
  - 解析器 / 协议握手等"成功失败都是常规结果"的场景
- 不要为了一致性把整个工程改成 Result 风格——会和生态摩擦严重。

## 3. 优先使用原生异步模式

- 使用 `async` / `await` 与原生 `Promise`。
- 不要无理由引入 RxJS、Effect-TS 等重型抽象。
- 并发原语优先 `Promise.all` / `Promise.allSettled` 与 `AbortController` / `AbortSignal`，而不是再造一套调度层。
- 需要节流 / 限流时使用 `p-limit`、`p-queue`、`p-retry` 等成熟库。

## 4. 类型系统的纪律

不安全的类型断言和 `any` 会让 strict mode 形同虚设。

- **禁止** `any`：需要"任意类型"的位置一律用 `unknown` 加类型守卫。
- **禁止不安全的 `as`**——即"绕过类型检查的强转"。以下用法是允许甚至推荐的：
  - `as const`：字面量收窄
  - `satisfies` 之后的隐式收窄（优先 `satisfies` 而不是 `as`）
  - 经过类型守卫 / schema 校验后的合法收窄
  - DOM API 中已知具体子类型时的向下转型（写一行注释说明）
- **禁止** `!` 非空断言：通过 early return / 类型守卫 / `??` / `?.` 处理；确实必须断言时写一行注释说明理由（与 Rust `expect("...")` 同义）。
- 解析外部数据（HTTP / 文件 / 用户输入 / IPC）一律走 schema 校验（推荐 `zod`），不允许直接 `as SomeType`。

## 5. 保持代码可维护性

- 长函数拆分为聚焦的辅助函数。
- 函数 / 变量使用有意义的名称，不要 `data`、`info`、`tmp`。
- 每个函数只做一件事。
- 默认写 pure function，副作用收敛到模块边界（IO / 网络 / 全局状态）。
- 仅为非显而易见的逻辑添加简洁注释；不要写"这段代码做什么"，要写"为什么这么做"。

## 6. 扁平化控制流

- early return / guard clause 让主路径保持在外层作用域。
- 类型收窄替代多层 `if`：`if (!user) return; user.xxx` 优于嵌套 `if (user) { ... }`。
- 错误分支优先 `throw` 或 `return`，避免用 `else` 包裹主逻辑。
- discriminated union + `switch` + `never` 穷尽性检查，代替散落的 `if / else if` 链：

  ```ts
  function assertNever(x: never): never { throw new Error(`unexpected: ${String(x)}`); }

  switch (event.kind) {
    case "open":  return handleOpen(event);
    case "close": return handleClose(event);
    default:      return assertNever(event);
  }
  ```

- 善用 `map` / `filter` / `reduce` / `flatMap` 替代命令式循环。

## 7. 字符串处理优先使用方法而非索引切片

优先使用 `String.prototype` 的方法：`split`、`trim`、`startsWith`、`endsWith`、`replaceAll`、`match`。

- 用 `s.startsWith("xxx") ? s.slice(3) : null` 代替手算 index。
- 能用正则就不要拼字符串拼位置。
- 处理路径用 `node:path`，不要自己拼 `/`。
- 处理 URL 用 `URL` / `URLSearchParams`，不要自己拼 query string。

## 8. 模块组织

`index.ts` 是 Node / npm 生态的标准目录入口（`import "./agent"` 自动解析到 `./agent/index.ts`），保留这个约定。规则约束的是它**怎么用**：

- **`index.ts` 只暴露子模块的公开 API**，是面向外部的"门面"。
- 子模块**内部互相引用走具体文件名**（`./session`、`./transport`），不要绕回自己的 `index.ts`。
- **禁止 `export * from "./xxx"`** 把整个子树打包；逐个 named re-export，让公开面是显式的。
- **避免深层 barrel 链**（A 的 index 引 B 的 index 引 C 的 index）——会破坏 tree-shaking、引入隐式循环依赖、让"这个符号在哪定义"变得模糊。
- 文件名直接反映其内容；子模块命名要与同级 module 在架构上并列，并能在父 module 的语境下简明反映其职责。

示例：

```
src/
  agent/
    index.ts          # 子模块公开入口：仅 re-export 对外 API
    agent.ts          # 主体实现
    session.ts        # 内部组件，被 agent.ts 直接 import
    session.test.ts
  transport/
    index.ts
    transport.ts
    websocket.ts
    http.ts
```

## 9. 不要造轮子

成熟社区实现优先：

- Schema 校验：`zod`
- 时间处理：Temporal（polyfill 或 Node 原生）/ `date-fns`
- HTTP 客户端：`undici` / `ky`
- 并发控制：`p-limit` / `p-queue` / `p-retry`
- 日志：`pino`
- CLI 参数：`commander` / `yargs`

不确定有无现成方案时，先看流行库依赖了什么，再决定是否复用而非自己写半成品。

## 10. 白箱（单元）测试

- 与被测代码同目录，命名 `<module>.test.ts`。
- 不要混入主代码文件；不要用 `__tests__/` 等其他命名。
- 整个工程统一使用同一测试运行器（推荐 `vitest`）。

## 11. 黑箱（集成 / E2E）测试

- 放在仓库根 `tests/` 目录下，命名 `<test_name>.test.ts`。
- 涉及外部服务时使用 `testcontainers`（Node 版本）搭建环境。
- 公共环境搭建逻辑放在 `tests/common.ts`，被各测试文件以 `import` 方式复用。

## 12. 语义正确性

从可维护性与 AI 友好性出发，重视语义正确。

### 子模块命名

与同级 module 在架构上并列，并能在父 module 的语境下简明反映其职责和功能。

### 不要忽略错误

- 禁止 `try { ... } catch { /* swallow */ }`。
- 禁止 `catch (e: any)`；统一 `catch (e: unknown)`，必要时收窄。
- 错误要么被显式处理（日志 / 降级 / 转换为业务错误），要么原样向上传播。
- 转换错误时保留原始原因：`throw new MyError("...", { cause: e })`。
- 不要用一个泛泛的 `Error` 表达多种失败语义；用自定义子类或带 `kind` 字段的 union。

### 类型即文档

类型的定义本身就在说明"它如何看待所组织的数据中各种关系"。

- 用 discriminated union 表达"几种互斥的形态"，不要用一堆可选字段堆出来。
- 用 `readonly` / `ReadonlyArray` / `ReadonlyMap` 表达不可变性。
- 用 `as const` 元组表达固定结构。
- 避免把 `Record<string, unknown>` 或宽泛 `object` 当成结构使用。
- 当一个原始类型（多为 `string` / `number`）在领域里有特殊语义且容易和其他同底层类型混淆时（如 `UserId` vs `OrderId`），考虑使用 branded type：

  ```ts
  type UserId = string & { readonly __brand: "UserId" };
  ```

  不要为了"看起来更类型安全"给所有 id 都加 brand——只在真有混淆风险时使用。

---

## tsconfig 基线

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

## 工具链

- ESLint：`@typescript-eslint/strict-type-checked` + `@typescript-eslint/stylistic-type-checked`。
- Prettier：保持默认配置，行宽 100。
- 提交前钩子：`tsc --noEmit` + `eslint` + `prettier --check`。CI 同样跑这三项。

## 风格细则

- **默认不使用 `enum`**，改用 `as const` 对象 + 字面量 union（避免数字 enum 的隐式转换问题、利于 tree-shaking）。
- **不可变优先**：函数参数偏好 `readonly T[]`、`ReadonlyMap`、`ReadonlySet`；新建对象用 spread 而非 mutate。
- **`type` vs `interface`**：默认用 `type`；只在需要 declaration merging（扩展第三方库或全局类型）时才用 `interface`。
- **import 用 `import type`** 区分类型导入；启用 `verbatimModuleSyntax` 强制约束。
- **优先 named export**，避免 default export（利于自动重命名 / 静态分析 / IDE 跳转）。
