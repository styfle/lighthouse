/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

import fs from 'fs';
import assert from 'assert';

import open from 'open';
import waitForExpect from 'wait-for-expect';
import puppeteer from 'puppeteer';

import {LH_ROOT} from '../../root.js';
import api from '../fraggle-rock/api.js';

const ARTIFACTS_PATH =
  `${LH_ROOT}/lighthouse-core/test/fixtures/fraggle-rock/artifacts/sample-flow-artifacts.json`;
const FLOW_RESULT_PATH =
  `${LH_ROOT}/lighthouse-core/test/fixtures/fraggle-rock/reports/sample-flow-result.json`;
const FLOW_REPORT_PATH = `${LH_ROOT}/dist/sample-reports/flow-report/index.html`;

/** @param {puppeteer.Page} page */
async function waitForImagesToLoad(page) {
  const TIMEOUT = 30_000;
  const QUIET_WINDOW = 3_000;

  /** @return {Promise<Array<{src: string, complete: boolean}>>} */
  async function getImageLoadingStates() {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .map(img => ({
          src: img.src,
          complete: img.complete,
        }))
    );
  }

  await waitForExpect(async () => {
    // First check all images that are in the page are complete.
    const firstRunImages = await getImageLoadingStates();
    const completeImages = firstRunImages.filter(image => image.complete);
    assert.deepStrictEqual(completeImages, firstRunImages);

    // Next check we haven't added any new images in the quiet window.
    await page.waitForTimeout(QUIET_WINDOW);
    const secondRunImages = await getImageLoadingStates();
    assert.deepStrictEqual(secondRunImages, firstRunImages);
  }, TIMEOUT);
}

/**
 * @param {LH.Result.MeasureEntry[]} timings
 */
function normalizeTimingEntries(timings) {
  let baseTime = 0;
  for (const timing of timings) {
    // @ts-expect-error: Value actually is writeable at this point.
    timing.startTime = baseTime++;
    // @ts-expect-error: Value actually is writeable at this point.
    timing.duration = 1;
  }
}

/** @type {LH.Config.Json} */
const config = {
  extends: 'lighthouse:default',
  settings: {
    skipAudits: ['uses-http2'],
  },
};

async function rebaselineArtifacts() {
  const browser = await puppeteer.launch({
    ignoreDefaultArgs: ['--enable-automation'],
    executablePath: process.env.CHROME_PATH,
    headless: false,
  });

  const page = await browser.newPage();
  const flow = await api.startFlow(page, {config});

  await flow.navigate('https://www.mikescerealshack.co');

  await flow.startTimespan({stepName: 'Search input'});
  await page.type('input', 'call of duty');
  const networkQuietPromise = page.waitForNavigation({waitUntil: ['networkidle0']});
  await page.click('button[type=submit]');
  await networkQuietPromise;
  await waitForImagesToLoad(page);
  await flow.endTimespan();

  await flow.snapshot({stepName: 'Search results'});

  await flow.navigate('https://www.mikescerealshack.co/corrections');

  await browser.close();

  const flowArtifacts = flow.createArtifactsJson();

  // Normalize some data so it doesn't change on every update.
  for (const {artifacts} of flowArtifacts.gatherSteps) {
    normalizeTimingEntries(artifacts.Timing);
  }

  fs.writeFileSync(ARTIFACTS_PATH, JSON.stringify(flowArtifacts, null, 2));
}

async function generateFlowResult() {
  /** @type {LH.UserFlow.FlowArtifacts} */
  const flowArtifacts = JSON.parse(fs.readFileSync(ARTIFACTS_PATH, 'utf-8'));
  const flowResult = await api.auditFlowArtifacts(flowArtifacts, config);

  // Normalize some data so it doesn't change on every update.
  for (const {lhr} of flowResult.steps) {
    normalizeTimingEntries(lhr.timing.entries);
    lhr.timing.total = lhr.timing.entries.length;
  }

  fs.writeFileSync(FLOW_RESULT_PATH, JSON.stringify(flowResult, null, 2));

  if (process.argv.includes('--view')) {
    const htmlReport = await api.generateFlowReport(flowResult);
    fs.writeFileSync(FLOW_REPORT_PATH, htmlReport);
    open(FLOW_REPORT_PATH);
  }
}

(async () => {
  try {
    if (process.argv.includes('--rebaseline-artifacts')) {
      await rebaselineArtifacts();
    }
    await generateFlowResult();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

