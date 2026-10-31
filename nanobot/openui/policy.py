"""Conservative automatic UI selection without an extra model request."""

import re

# shortcut: Chinese/English intent cues; extend after validating other languages.
_TEXT_ONLY = re.compile(
    r"只(?:要|用|需)(?:纯)?(?:文字|文本)|纯文本|不要[^。！？\n]{0,24}(?:组件|按钮|表单|交互)"
    r"|\b(?:plain text|text only|no (?:interactive |UI )?(?:components|buttons|forms))\b", re.I,
)
_REQUEST = re.compile(
    r"(?:用|给|通过|显示|生成|提供|做成|以)[^。！？\n]{0,80}(?:可点击|按钮|表单|交互|下拉)"
    r"|(?:让我|让用户)[^。！？\n]{0,60}(?:选择|填写|确认)"
    r"|\b(?:show|give|use|create|render|display|make|offer|collect)\b[^.!?\n]{0,80}"
    r"\b(?:interactive|clickable|buttons?|forms?|drop.?down)\b", re.I,
)
_ASK = re.compile(
    r"请(?:先)?(?:选择|确认|填写|补充|提供|告诉|回复)|你(?:想|希望|更喜欢)|需要你(?:提供|确认)"
    r"|\b(?:(?:would|could|can) you|please (?:choose|pick|select|confirm|provide|enter|fill)"
    r"|which (?:option|one|style|type)|what (?:is your|would you))\b"
    r"|(?:^|[.!?。！？][ \t]+)[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(?:choose|pick|select)[ \t]+"
    r"(?:(?:one|between)\b|[^\n]{1,160}\bor\b[^\n]{1,160})", re.I | re.M,
)
_SURVEY = re.compile(r"调查表|调查问卷|问卷|\b(?:questionnaire|survey)\b", re.I)
_RENAME = re.compile(
    r"(?:重命名|改名|改.{0,4}标题)[^。！？\n]{0,20}(?:当前|这个|本|这条)?(?:会话|对话)"
    r"|(?:当前|这个|本|这条)(?:会话|对话)[^。！？\n]{0,20}(?:重命名|改名|标题改|标题设)"
    r"|\brename\s+(?:this|the current)\s+(?:chat|conversation)\b", re.I,
)


def should_generate_view(question: str, answer: str, *, has_tables: bool) -> bool:
    """Prefer text unless authorized data or a concrete interaction is present.

    This is a bounded Chinese/English heuristic. Explicit OpenUI mode remains
    available when automatic selection misses an intent or another language.
    """
    question = question[:4000]
    if _TEXT_ONLY.search(question):
        return False
    intent = re.sub(r"```.*?(?:```|$)", "", question, flags=re.S)
    intent = "\n".join(line for line in intent.splitlines() if not line.lstrip().startswith(">"))
    if has_tables or _REQUEST.search(question) or _RENAME.search(intent):
        return True
    # Examples and quoted instructions in an explanation are not questions to
    # the current user. Do not let code samples alone trigger a UI request.
    answer = re.sub(r"```.*?(?:```|$)", "", answer[:16000], flags=re.S)
    answer = "\n".join(line for line in answer.splitlines() if not line.lstrip().startswith(">"))
    return _ASK.search(answer) is not None or (_SURVEY.search(answer) is not None and re.search(
        r"(?m)^\s*(?:#{1,6}\s*)?(?:\*\*)?\d+[.、．)）][^\n]*[?？]"
        r"|^\s*(?:[-*]\s*)?(?:[□☐]|\[[ x]?\])\s*\S", answer,
    ) is not None)
