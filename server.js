const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseRecipients(rawRows) {
  if (!Array.isArray(rawRows)) {
    throw new Error('rows는 배열이어야 합니다.');
  }

  const recipients = rawRows
    .map((row) => {
      const name = String(row.name || '').trim();
      const point = Number(row.point);
      if (!name || Number.isNaN(point) || point <= 0) {
        return null;
      }
      return { name, point };
    })
    .filter(Boolean);

  if (!recipients.length) {
    throw new Error('유효한 지급 대상이 없습니다.');
  }

  return recipients;
}

async function getTargetFrame(page, frameUrlKeyword) {
  if (!frameUrlKeyword) {
    return page.mainFrame();
  }

  const timeout = Date.now() + 15000;
  while (Date.now() < timeout) {
    const frame = page.frames().find((f) => f.url().includes(frameUrlKeyword));
    if (frame) return frame;
    await page.waitForTimeout(300);
  }

  throw new Error(`iframe(${frameUrlKeyword})를 찾지 못했습니다.`);
}

async function fillByStrategies(frame, selector, strategies, value) {
  if (selector) {
    const target = frame.locator(selector).first();
    await target.fill('');
    await target.fill(value);
    return;
  }

  for (const query of strategies) {
    const target = frame.locator(query).first();
    if (await target.count()) {
      await target.fill('');
      await target.fill(value);
      return;
    }
  }

  throw new Error(`입력 필드를 찾지 못했습니다: ${value}`);
}

async function clickByStrategies(frame, selector, strategies) {
  if (selector) {
    await frame.locator(selector).first().click();
    return;
  }

  for (const query of strategies) {
    const button = frame.locator(query).first();
    if (await button.count()) {
      await button.click();
      return;
    }
  }

  throw new Error('지급 버튼을 찾지 못했습니다.');
}

app.post('/api/grant', async (req, res) => {
  const {
    targetUrl,
    frameUrlKeyword,
    selectors = {},
    recipients: rawRows,
    chatTemplate,
    delayMs = 600
  } = req.body || {};

  if (!targetUrl) {
    return res.status(400).json({ ok: false, message: 'targetUrl이 필요합니다.' });
  }

  let recipients;
  try {
    recipients = parseRecipients(rawRows);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

  const browserContext = await chromium.launchPersistentContext(path.join(__dirname, '.auth'), {
    headless: false,
    viewport: { width: 1440, height: 900 }
  });

  const page = browserContext.pages()[0] || (await browserContext.newPage());
  const result = [];

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    const frame = await getTargetFrame(page, frameUrlKeyword);

    for (const item of recipients) {
      await fillByStrategies(
        frame,
        selectors.name,
        [
          'input[placeholder*="이름"]',
          'input[aria-label*="이름"]',
          'input[name*="name" i]'
        ],
        item.name
      );

      await fillByStrategies(
        frame,
        selectors.point,
        [
          'input[placeholder*="포인트"]',
          'input[aria-label*="포인트"]',
          'input[name*="point" i]',
          'input[type="number"]'
        ],
        String(item.point)
      );

      if (selectors.count) {
        await fillByStrategies(frame, selectors.count, [], '1');
      }

      await clickByStrategies(
        frame,
        selectors.submit,
        [
          'button:has-text("지급")',
          'button:has-text("전송")',
          'button:has-text("적용")',
          'button[type="submit"]'
        ]
      );

      if (chatTemplate) {
        const msg = chatTemplate
          .replaceAll('{name}', item.name)
          .replaceAll('{point}', String(item.point));

        const chatInputCandidates = [
          selectors.chatInput,
          'textarea[placeholder*="메시지"]',
          'input[placeholder*="메시지"]',
          'div[contenteditable="true"]'
        ].filter(Boolean);

        for (const candidate of chatInputCandidates) {
          const chat = page.locator(candidate).first();
          if (await chat.count()) {
            await chat.fill('');
            await chat.type(msg);
            await chat.press('Enter');
            break;
          }
        }
      }

      result.push({ ...item, status: 'success' });
      await page.waitForTimeout(Number(delayMs) || 600);
    }

    return res.json({ ok: true, count: result.length, result });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message, result });
  } finally {
    await browserContext.close();
  }
});

app.listen(PORT, () => {
  console.log(`autoPoint 서버 실행중: http://localhost:${PORT}`);
});
