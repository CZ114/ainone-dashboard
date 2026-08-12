import type {
  ConditionDefinition,
  EvaluationForms,
  FormFieldDefinition,
  FormOption,
  StudyManifest,
} from './types';

export const STUDY_MANIFEST: StudyManifest = {
  id: 'advoice-doctor-three-condition-v1',
  title: 'ADvoice 医生三条件评测',
  description:
    '比较三种分析方法对临床筛查与转诊决策的支持；方法身份仅在研究者揭盲模式显示。',
  defaultLocale: 'zh-CN',
  supportedLocales: ['zh-CN', 'en-GB'],
  disclaimer:
    '本系统仅用于语音认知筛查决策支持，不替代病史、日常功能、认知量表、神经心理检查或生物标志物诊断。',
  blinding: {
    defaultMode: 'blinded',
    revealPolicy: 'researcher_only',
    truthField: 'researchOnly',
  },
  interactionPolicy: {
    reportChat: {
      enabledFor: ['ours'],
      recordUsage: true,
      treatAsIndependentVariable: true,
    },
  },
};

export const CONDITIONS: ConditionDefinition[] = [
  {
    id: 'b1',
    methodKind: 'plain_model',
    blindLabel: '条件 A',
    name: '普通模型',
    shortDescription: '仅提供筛查分类和风险值。',
    capabilities: {
      riskScore: true,
      narrativeReport: false,
      structuredReport: false,
      reportChat: false,
      stateCards: false,
      evidenceTrace: false,
    },
  },
  {
    id: 'b2',
    methodKind: 'standard_agent',
    blindLabel: '条件 B',
    name: '普通 Agent',
    shortDescription: '提供筛查分类、风险值和不带结构化回溯的文字报告。',
    capabilities: {
      riskScore: true,
      narrativeReport: true,
      structuredReport: false,
      reportChat: false,
      stateCards: false,
      evidenceTrace: false,
    },
  },
  {
    id: 'ours',
    methodKind: 'improved_agent',
    blindLabel: '条件 C',
    name: '改良 Agent',
    shortDescription: '提供结构化报告、报告问答、临床状态和可回听证据轨迹。',
    capabilities: {
      riskScore: true,
      narrativeReport: true,
      structuredReport: true,
      reportChat: true,
      stateCards: true,
      evidenceTrace: true,
    },
  },
];

const judgmentOptions: FormOption[] = [
  { value: 'no_cognitive_impairment', label: '未见认知障碍' },
  { value: 'mci', label: '轻度认知障碍（MCI）' },
  { value: 'ad_adrd', label: '阿尔茨海默病相关认知障碍（AD/ADRD）' },
  { value: 'cognitive_impairment_untyped', label: '认知障碍阳性但无法分型' },
  { value: 'insufficient_evidence', label: '证据不足' },
];

const likert = (
  id: string,
  label: string,
  leftAnchor = '非常不同意',
  rightAnchor = '非常同意',
): FormFieldDefinition => ({
  id,
  label,
  kind: 'likert_5',
  required: true,
  min: 1,
  max: 5,
  leftAnchor,
  rightAnchor,
});

export const EVALUATION_FORMS: EvaluationForms = {
  profileFields: [
    { id: 'participantCode', label: '匿名编号', kind: 'text', required: true },
    {
      id: 'ageRange',
      label: '年龄范围',
      kind: 'single_select',
      required: false,
      options: ['25岁以下', '25–34岁', '35–44岁', '45–54岁', '55岁及以上'].map((value) => ({ value, label: value })),
    },
    {
      id: 'gender',
      label: '性别（可不答）',
      kind: 'single_select',
      required: false,
      options: ['女', '男', '非二元/其他', '不愿回答'].map((value) => ({ value, label: value })),
    },
    { id: 'specialty', label: '专科', kind: 'text', required: false },
    {
      id: 'trainingLevel',
      label: '职称/培训阶段',
      kind: 'single_select',
      required: false,
      options: ['住院医师', '专科培训医师', '主治医师', '副主任/主任医师', '全科医生', '其他'].map(
        (value) => ({ value, label: value }),
      ),
    },
    { id: 'yearsClinical', label: '临床工作年限', kind: 'number', required: false, min: 0 },
    {
      id: 'cognitiveExperience',
      label: '认知障碍诊疗经验',
      kind: 'single_select',
      required: false,
      options: ['无', '少于1年', '1–3年', '4–7年', '8年以上'].map((value) => ({ value, label: value })),
    },
    {
      id: 'weeklyCognitiveCases',
      label: '每周接触认知主诉患者数',
      kind: 'single_select',
      required: false,
      options: ['0', '1–2', '3–5', '6–10', '10以上'].map((value) => ({ value, label: value })),
    },
    { id: 'aiFamiliarity', label: '临床人工智能熟悉程度', kind: 'likert_5', required: false, min: 1, max: 5 },
    {
      id: 'speechBiomarkerExperience',
      label: '是否使用过语音/数字生物标志物',
      kind: 'single_select',
      required: false,
      options: ['从未', '仅了解', '研究中使用', '临床中使用'].map((value) => ({ value, label: value })),
    },
    { id: 'institutionType', label: '机构类型', kind: 'text', required: false },
    { id: 'languages', label: '可评估的语言', kind: 'text', required: false },
  ],
  caseRatingFields: [
    {
      id: 'judgment',
      label: '您的分类判断',
      kind: 'single_select',
      required: true,
      options: judgmentOptions,
    },
    likert('confidence', '判断信心', '完全没有信心', '非常有信心'),
    likert('usefulness', '对筛查/转诊决策的帮助'),
    likert('clarity', '信息清晰度'),
    likert('traceability', '依据可核查性'),
    likert('safety', '不确定性与限制说明充分'),
    likert('effort', '阅读负担', '非常低', '非常高'),
    { id: 'comment', label: '补充意见', kind: 'textarea', required: false },
  ],
  overallFields: [
    {
      id: 'preferredConditionId',
      label: '最适合临床使用的条件',
      kind: 'single_select',
      required: true,
      options: CONDITIONS.map((condition) => ({ value: condition.id, label: condition.blindLabel })),
    },
    {
      id: 'secondConditionId',
      label: '第二选择',
      kind: 'single_select',
      required: true,
      options: CONDITIONS.map((condition) => ({ value: condition.id, label: condition.blindLabel })),
    },
    likert('confidence', '对总体选择的信心', '完全没有信心', '非常有信心'),
    likert('workflowFit', '与现有筛查流程的契合度'),
    likert('adoption', '愿意在临床筛查中使用'),
    likert('overrelianceConcern', '担心使用者过度依赖系统', '完全不担心', '非常担心'),
    {
      id: 'mostValuableInformation',
      label: '最有价值的信息',
      kind: 'single_select',
      required: true,
      options: ['风险值', '自然语言总结', '临床状态卡', '原始指标值', '片段音频回溯', '不确定性/限制', '下一步建议'].map(
        (value) => ({ value, label: value }),
      ),
    },
    { id: 'reason', label: '选择原因', kind: 'textarea', required: false },
    { id: 'missingInformation', label: '仍缺少的信息、潜在风险或建议修改', kind: 'textarea', required: false },
  ],
  questionnaires: [
    {
      id: 'sus',
      title: '系统可用性量表（SUS）',
      description: '标准 10 题、5 点量表；奇偶题按标准规则计分。',
      scale: { min: 1, max: 5, leftAnchor: '非常不同意', rightAnchor: '非常同意' },
      items: [
        '我愿意经常使用这套系统',
        '我觉得这套系统不必要地复杂',
        '我觉得这套系统容易使用',
        '我认为需要技术人员帮助才能使用',
        '我觉得系统中的各项功能整合良好',
        '我觉得系统中存在太多不一致',
        '我认为大多数临床人员能很快学会使用',
        '我觉得使用过程很繁琐',
        '我对使用这套系统有信心',
        '我需要学习很多内容才能开始使用',
      ].map((text, index) => ({ id: `sus_${index + 1}`, text, reverseScored: index % 2 === 1 })),
    },
    {
      id: 'clinical_evidence_safety',
      title: '临床证据与安全量表',
      description: '评估证据完整性、临床可解释性、安全性、分诊价值与可追溯性。',
      scale: { min: 1, max: 5, leftAnchor: '非常不同意', rightAnchor: '非常同意' },
      items: [
        '系统提供的证据足以支持筛查或转诊判断',
        '我能理解系统为什么给出当前分类',
        '系统清楚说明了不确定性和证据限制',
        '我能把报告中的主要结论追溯到原始音频或指标',
        '系统避免把录音质量或低解释性特征直接解释为疾病机制',
        '当系统建议可能有误时，我能够识别并纠正它',
      ].map((text, index) => ({ id: `clinical_${index + 1}`, text })),
    },
  ],
};
