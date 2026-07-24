import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFileConfig } from '../src/lib/config';
import { createPatternAnalyzer, type LabeledVacancy } from '../src/lib/patterns';

const cfg = loadFileConfig();
const analyzer = createPatternAnalyzer(cfg);

const v = (label: 'relevant' | 'irrelevant', title: string, description: string, extra: Partial<LabeledVacancy> = {}): LabeledVacancy => ({
  label,
  title,
  description,
  key_skills: null,
  salary: null,
  employer: null,
  ...extra,
});

const fixture: LabeledVacancy[] = [
  v('relevant', 'AI-инженер', 'Строим RAG пайплайны на Python', { salary: { from: 300_000, currency: 'RUR' }, employer: 'GoodCo' }),
  v('relevant', 'LLM-инженер', 'Python, RAG, векторные базы', { employer: 'GoodCo' }),
  v('relevant', 'AI engineer', 'RAG, python, приложения на LLM', {}),
  v('irrelevant', 'Программист 1C', 'Поддержка 1C и Битрикс', { salary: { from: 100_000, currency: 'RUR' }, employer: 'BadCo' }),
  v('irrelevant', 'Разработчик Битрикс', 'Битрикс, 1C, интеграции', { employer: 'BadCo' }),
];

test('частотный анализ: RAG/python в топе лайкнутых, 1C/битрикс — в дизлайкнутых', () => {
  const report = analyzer.analyze(fixture);
  assert.equal(report.nLike, 3);
  assert.equal(report.nDislike, 2);
  const likeTerms = report.likeTop.map((t) => t.term);
  const dislikeTerms = report.dislikeTop.map((t) => t.term);
  assert.ok(likeTerms.includes('rag'), 'rag в топе 👍: ' + likeTerms.join(','));
  assert.ok(likeTerms.includes('python'));
  assert.ok(dislikeTerms.includes('битрикс'), 'битрикс в топе 👎: ' + dislikeTerms.join(','));
});

test('lift: слово из лайков > 1, слово из дизлайков < 1', () => {
  const report = analyzer.analyze(fixture);
  const rag = [...report.likeTop, ...report.liftTop].find((t) => t.term === 'rag');
  assert.ok(rag && rag.lift > 1, `lift(rag)=${rag?.lift}`);
  const bitrix = report.dislikeTop.find((t) => t.term === 'битрикс');
  assert.ok(bitrix && bitrix.lift < 1, `lift(битрикс)=${bitrix?.lift}`);
});

test('markdown-отчёт содержит базовую статистику, вилки и работодателей', () => {
  const md = analyzer.analyze(fixture).markdown;
  assert.ok(md.includes('👍 3 · 👎 2'));
  assert.ok(md.includes('Зарплатные вилки'));
  assert.ok(md.includes('GoodCo'));
  assert.ok(md.includes('вручную'), 'отчёт напоминает: выводы применяются вручную');
});

test('пустой набор меток: «Недостаточно данных», без падения', () => {
  const report = analyzer.analyze([]);
  assert.equal(report.nLike, 0);
  assert.equal(report.nDislike, 0);
  assert.ok(report.markdown.includes('Недостаточно данных'));
});

test('tech-термины из словаря конфига находятся подстрокой (мультисловные)', () => {
  const items = [
    v('relevant', 'ML-инженер', 'Ищем специалиста по machine learning и prompt engineering'),
    v('irrelevant', 'Оператор', 'Ввод данных'),
  ];
  const report = analyzer.analyze(items);
  const terms = report.likeTop.map((t) => t.term);
  assert.ok(terms.includes('machine learning'));
  assert.ok(terms.includes('prompt engineering'));
});
