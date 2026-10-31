"""Automatic UI selection must avoid paying for ordinary text answers."""

import pytest

from nanobot.openui.policy import should_generate_view


@pytest.mark.parametrize(("question", "answer", "tables", "expected"), [
    ("什么是变量？", "变量用于保存一个值。", False, False),
    ("Explain variables", "A variable stores a value.", False, False),
    ("什么是表单？", "表单用于收集用户输入。", False, False),
    ("Explain confirmations", 'Example:\n```text\nPlease confirm the choice.\n```', False, False),
    ("给我三个可点击选项", "可以选择散步、逛展或探店。", False, True),
    ("Use a short form to collect the details", "A name and priority are needed.", False, True),
    ("制定学习计划", "请先提供每天可投入的时间。", False, True),
    ("项目代号: LANTERN-2026", "请回复“修改需求”或“确认需求”。", False, True),
    ("修改项目需求", "项目需求调查表（修改版）\n项目代号：LANTERN-2026。\n请修改需要调整的字段，再提交答案。", False, True),
    ("修改项目需求", "项目需求调查表（修改版）\n- ● 文档\n- ○ 演示\n- ☑ 可靠性", False, True),
    ("Help me plan", "Which option would you prefer?", False, True),
    ("Analyze Saved conversations: Planning notes",
     'Acceptance code: ORBIT-742. Next step: a read-only release review.\n\nChoose one: "Summarize notes" or "Review risks".', False, True),
    ("Help me plan", '**Pick one:** draft or review.', False, True),
    ("Help me plan", '- Select between draft and review.', False, True),
    ("Help me plan", 'Choose **“Draft”** or **“Review.”**', False, True),
    ("Help me plan", 'Pick draft or review.', False, True),
    ("Analyze Saved conversations: Planning notes",
     'The acceptance code is ORBIT-742, and the next step is a read-only release review. Choose one: “Summarize notes” or “Review risks”.', False, True),
    ("Help me plan", 'The scope is ready. Pick draft or review.', False, True),
    ("Explain options", 'The scope is ready. To choose one option, compare their costs.', False, False),
    ("Explain an option prompt", 'Example:\n```text\nChoose one: draft or review.\n```', False, False),
    ("Explain an option prompt", 'Example:\n> Choose one: draft or review.', False, False),
    ("Explain options", 'To choose one option, compare their costs.', False, False),
    ("搜索相关会话", "找到两条结果。", True, True),
    ("只要文字，搜索相关会话", "找到两条结果。", True, False),
    ("Text only, please", "Please choose one of these options.", False, False),
    ("把这条会话改名为项目开发计划", "可以在对话内修改标题。", False, True),
    ("Rename this chat to Project plan", "The title needs confirmation.", False, True),
    ("Text only: rename this chat to Plan", "The title needs confirmation.", False, False),
    ("Explain this example:\n```text\nRename this chat to Plan\n```", "This is an example.", False, False),
    ("Explain this example:\n> Rename this chat to Plan", "This is an example.", False, False),
    ("做一份就业情况调查表", "# 公司员工就业情况调查表\n1. 您目前的工作状态是？\n□ 在职 □ 已离职", False, True),
    ("Create an employee survey", "Employee survey\n1. What is your employment status?\n- Employed\n- Other", False, True),
    ("问卷是什么？", "问卷可以用来收集数据。如何设计问卷？首先确定目标。", False, False),
    ("Explain a survey", "Survey example:\n```text\n1. Are you employed?\n```", False, False),
    ("解释调查表", "调查表例如：\n> 1. 您目前的工作状态是？", False, False),
    ("只要文字问卷", "调查表\n1. 您目前的工作状态是？\n□ 在职 □ 离职", False, False),
])
def test_selects_useful_interactions_without_a_classifier_call(question, answer, tables, expected):
    assert should_generate_view(question, answer, has_tables=tables) is expected
