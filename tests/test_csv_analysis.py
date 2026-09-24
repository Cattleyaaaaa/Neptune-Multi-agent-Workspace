"""上下文被追加系统提示与知识库片段之后，贴进来的 CSV 仍然要能解析。

这是一个实测出来的真问题：用户在任务背景里贴了 CSV，数据步骤却回复"请把 CSV 粘贴到
背景里" —— 因为整段上下文（CSV + 系统约束 + 知识库片段）丢给 csv.Sniffer 会解析失败。
"""

from pathlib import Path

from packages.general_agent.tools import ToolRegistry, csv_blocks, parse_csv_table

MIXED = (
    "month,sales\n1,10\n2,20\n3,30\n\n"
    "优先使用可核验信息；明确标注假设、限制和待审批动作。\n\n"
    "[知识库：通用知识库]\n数据库选型必须先给出读写比与一致性要求。"
)


def test_finds_table_inside_mixed_context() -> None:
    parsed = parse_csv_table(MIXED)

    assert parsed is not None, "混合上下文里应该仍能挑出表格"
    rows, columns = parsed
    assert columns == ["month", "sales"]
    assert len(rows) == 3


def test_blocks_are_ranked_by_size() -> None:
    blocks = csv_blocks(MIXED)

    assert blocks, "至少应该切出一个候选块"
    assert blocks[0].startswith("month,sales")


def test_analyze_csv_detects_mixed_context(tmp_path: Path) -> None:
    registry = ToolRegistry(tmp_path)

    result, _ = registry.invoke("analyze_csv", "data_agent", {"content": MIXED})

    assert result["detected"] is True
    assert result["numeric_summary"]["sales"]["mean"] == 20.0


def test_analyze_csv_says_so_when_there_is_no_table(tmp_path: Path) -> None:
    registry = ToolRegistry(tmp_path)

    result, _ = registry.invoke(
        "analyze_csv", "data_agent", {"content": "这是一段纯文字说明，没有表格。"}
    )

    assert result["detected"] is False
    assert "表格" in str(result["reason"])
