import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRemoteOkApi, parseWwrRss } from '../src/lib/remote-sources';

test('Remote OK API rows normalize into vacancy candidates', () => {
  const rows = [
    { last_updated: 1, legal: 'terms' },
    {
      id: 123,
      position: 'AI Engineer',
      company: 'Acme',
      tags: ['python', 'llm'],
      description: '<p>Build RAG systems</p>',
      location: 'Worldwide',
      salary_min: 100000,
      salary_max: 150000,
      date: '2026-07-29T20:00:01+00:00',
      apply_url: 'https://remoteOK.com/remote-jobs/123',
    },
  ];

  const jobs = parseRemoteOkApi(rows);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'remoteok:123');
  assert.equal(jobs[0].source, 'remoteok');
  assert.equal(jobs[0].title, 'AI Engineer');
  assert.equal(jobs[0].employer, 'Acme');
  assert.equal(jobs[0].description, 'Build RAG systems');
  assert.deepEqual(jobs[0].salary, { from: 100000, to: 150000, currency: 'USD', gross: null });
  assert.deepEqual(jobs[0].keySkills, ['python', 'llm']);
  assert.equal(jobs[0].raw.source, 'remoteok');
});

test('We Work Remotely RSS items normalize into vacancy candidates', () => {
  const xml = `<?xml version="1.0"?>
  <rss><channel><item>
    <title>Acme: Backend Engineer</title>
    <link>https://weworkremotely.com/remote-jobs/acme-backend-engineer</link>
    <guid>https://weworkremotely.com/remote-jobs/acme-backend-engineer</guid>
    <region>Anywhere in the World</region>
    <country>Remote</country>
    <category>Programming</category>
    <type>Full-Time</type>
    <skills>Python, LLM</skills>
    <pubDate>Wed, 29 Jul 2026 20:00:00 +0000</pubDate>
    <description>&lt;p&gt;Build AI agents&lt;/p&gt;</description>
  </item></channel></rss>`;

  const jobs = parseWwrRss(xml);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, 'wwr');
  assert.equal(jobs[0].title, 'Backend Engineer');
  assert.equal(jobs[0].employer, 'Acme');
  assert.equal(jobs[0].area, 'Anywhere in the World, Remote');
  assert.equal(jobs[0].description, 'Build AI agents');
  assert.deepEqual(jobs[0].keySkills, ['Programming', 'Full-Time', 'Python', 'LLM']);
  assert.equal(jobs[0].raw.source, 'wwr');
});
