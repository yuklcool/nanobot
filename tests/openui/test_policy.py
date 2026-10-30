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
    ("Help me plan", "Which option would you prefer?", False, True),
    ("搜索相关会话", "找到两条结果。", True, True),
    ("只要文字，搜索相关会话", "找到两条结果。", True, False),
    ("Text only, please", "Please choose one of these options.", False, False),
])
def test_selects_useful_interactions_without_a_classifier_call(question, answer, tables, expected):
    assert should_generate_view(question, answer, has_tables=tables) is expected
