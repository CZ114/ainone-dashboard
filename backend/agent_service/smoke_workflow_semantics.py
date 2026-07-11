"""Workflow 引擎语义测试 (FakeAgent, 零 LLM 调用) — 跑完可删。"""
from agent.orchestration import Workflow, WorkflowError, validate_spec

PASS, FAIL = "  [PASS]", "  [FAIL]"
failures = []


def check(label, cond, detail=""):
    print(f"{PASS if cond else FAIL} {label}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(label)


class FakeAgent:
    """脚本化回复; 记录收到的每条 prompt (验证历史保留/传参)。"""
    def __init__(self, name, script):
        self.name, self.script, self.received = name, script, []

    def send(self, text):
        self.received.append(text)
        step = len(self.received) - 1
        return self.script[min(step, len(self.script) - 1)]


built = {}
def make_factory(scripts):
    built.clear()
    def build(name):
        built[name] = FakeAgent(name, scripts[name])
        return built[name]
    return build


# 1. pipeline 顺序传参
wf = Workflow({
    "id": "p", "inputs": ["task"],
    "steps": [
        {"type": "agent", "id": "a_out", "agent": "A", "prompt": "做: {task}"},
        {"type": "agent", "id": "b_out", "agent": "B", "prompt": "基于 <{a_out}> 继续"},
    ],
})
r = wf.run_sync({"task": "T1"}, make_factory({"A": ["A的结果"], "B": ["B的结果"]}))
check("pipeline: 变量传递", built["B"].received[0] == "基于 <A的结果> 继续")
check("pipeline: 默认输出=最后一步", r["output"] == "B的结果")

# 2. loop + break_if (critic 第2轮 APPROVED → 跳出, reviser 第2轮不执行)
wf = Workflow({
    "id": "l", "inputs": ["task"], "output": "{draft}",
    "steps": [
        {"type": "agent", "id": "draft", "agent": "writer", "prompt": "{task}"},
        {"type": "loop", "id": "rev", "max_iters": 5, "steps": [
            {"type": "agent", "id": "review", "agent": "critic", "prompt": "审: {draft}"},
            {"type": "break_if", "when": {"var": "review", "contains": "APPROVED"}},
            {"type": "agent", "id": "draft", "agent": "writer", "prompt": "改: {review}"},
        ]},
    ],
})
r = wf.run_sync({"task": "写"}, make_factory({
    "writer": ["v1", "v2", "v3"], "critic": ["不行, 改", "APPROVED"]}))
kinds = [e["event"] for e in r["trace"]]
check("loop: 正确跳出", "loop_break" in kinds)
check("loop: critic 跑了2轮", len(built["critic"].received) == 2)
check("loop: writer 只改了1次(初稿+1修)", len(built["writer"].received) == 2)
check("loop: 输出是 v2", r["output"] == "v2")
check("loop: 节点历史保留(同实例)", built["writer"].received[1] == "改: 不行, 改")

# 3. parallel 并发 + 汇总
wf = Workflow({
    "id": "par", "inputs": ["q"],
    "steps": [
        {"type": "parallel", "steps": [
            {"type": "agent", "id": "x", "agent": "X", "prompt": "{q}"},
            {"type": "agent", "id": "y", "agent": "Y", "prompt": "{q}"},
        ]},
        {"type": "agent", "id": "final", "agent": "Z", "prompt": "综合 {x} + {y}"},
    ],
})
r = wf.run_sync({"q": "Q"}, make_factory({"X": ["xx"], "Y": ["yy"], "Z": ["zz"]}))
check("parallel: 两输出都进变量池", built["Z"].received[0] == "综合 xx + yy")

# 4. route 动态分支
wf = Workflow({
    "id": "rt", "inputs": ["q"],
    "steps": [{
        "type": "route", "id": "kind", "agent": "router", "prompt": "{q}",
        "routes": {
            "医疗": [{"type": "agent", "id": "ans", "agent": "MED", "prompt": "医疗答 {q}"}],
            "音乐": [{"type": "agent", "id": "ans", "agent": "MUS", "prompt": "音乐答 {q}"}],
        }, "default": "音乐",
    }],
})
r = wf.run_sync({"q": "心率异常"}, make_factory(
    {"router": ["这属于医疗类"], "MED": ["MED答"], "MUS": ["MUS答"]}))
choice = next(e for e in r["trace"] if e["event"] == "route_choice")["choice"]
check("route: 命中医疗分支", choice == "医疗" and r["output"] == "MED答")
check("route: 未选分支不执行", "MUS" not in built)

# 5. 防御: 未知变量 / parallel 同名节点 / max_iters 越界
try:
    Workflow({"id": "bad", "steps": [
        {"type": "agent", "id": "a", "agent": "A", "prompt": "{nope}"}]}).run_sync(
        {}, make_factory({"A": ["x"]}))
    check("未知变量报错", False)
except WorkflowError as e:
    check("未知变量报错", "nope" in str(e))

probs = validate_spec({"id": "bad2", "steps": [
    {"type": "parallel", "steps": [
        {"type": "agent", "id": "a", "agent": "SAME", "prompt": "1"},
        {"type": "agent", "id": "b", "agent": "SAME", "prompt": "2"}]}]})
check("parallel 同名节点被校验拦下", any("互不相同" in p for p in probs))
probs = validate_spec({"id": "bad3", "steps": [
    {"type": "loop", "max_iters": 999, "steps": [
        {"type": "agent", "id": "a", "agent": "A", "prompt": "x"}]}]})
check("max_iters 越界被拦下", any("max_iters" in p for p in probs))

print()
if failures:
    print(f"{len(failures)} 项失败: {failures}")
    raise SystemExit(1)
print("引擎语义全部通过 ✔")
