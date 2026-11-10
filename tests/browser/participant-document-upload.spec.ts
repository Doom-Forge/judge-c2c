import { expect, test } from '@playwright/test';

test('participant uploads validated documents and retains secure version history', async ({
  page,
}) => {
  const uploads: { name: string; type: string; bytes: number }[] = [];
  let documents: Record<string, unknown>[] = [];
  const pdf = Buffer.from('%PDF-1.7\nparticipant evidence');
  const largePdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(2 * 1024 * 1024),
  ]);
  await page.route('**/api/organization/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/organization/status') {
      return route.fulfill({
        json: {
          organization: 'Fixture',
          authenticated: true,
          role: 'participant',
          identity: {
            id: 'person-a',
            name: 'Alice',
            role: 'participant',
            teamId: 'team-a',
          },
        },
      });
    }
    if (path === '/api/organization/participant') {
      return route.fulfill({
        json: {
          team: { id: 'team-a', name: 'Team A' },
          track: { fullName: 'fixture/alpha', repositoryId: 17 },
          submissions: [],
          evaluations: [],
        },
      });
    }
    if (
      path === '/api/organization/participant/documents' &&
      request.method() === 'GET'
    ) {
      return route.fulfill({ json: { documents } });
    }
    if (
      path === '/api/organization/participant/documents' &&
      request.method() === 'POST'
    ) {
      const contentType = await request.headerValue('content-type');
      const body = request.postDataBuffer();
      const boundary = contentType
        ?.match(/boundary=(?:"([^"]+)"|([^;]+))/)
        ?.slice(1)
        .find(Boolean);
      if (
        !contentType?.startsWith('multipart/form-data;') ||
        !body ||
        !boundary
      ) {
        return route.fulfill({
          status: 400,
          json: { error: 'INVALID_DOCUMENT_UPLOAD' },
        });
      }
      const multipartBody = Buffer.from(body).toString('latin1');
      const filePart = multipartBody
        .split(`--${boundary}`)
        .find((part: string) => part.includes('name="file"'));
      const fileName = filePart?.match(/filename="([^"]+)"/)?.[1];
      const fileType = filePart?.match(/Content-Type:\s*([^\r\n]+)/i)?.[1];
      const fileContent = filePart?.split('\r\n\r\n')[1]?.replace(/\r\n$/, '');
      if (!filePart || !fileName || !fileType || fileContent === undefined) {
        return route.fulfill({
          status: 400,
          json: { error: 'INVALID_DOCUMENT_UPLOAD' },
        });
      }
      const fileBytes = Buffer.from(fileContent, 'latin1');
      uploads.push({
        name: fileName,
        type: fileType,
        bytes: fileBytes.length,
      });
      const document = {
        id:
          `${uploads.length}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
        version: uploads.length,
        filename: fileName,
        content_type: fileType,
        bytes: fileBytes.length,
        status: 'STORED',
        created_at: '2026-11-08T00:00:00Z',
      };
      documents = [document, ...documents];
      return route.fulfill({ status: 201, json: { document } });
    }
    if (path.startsWith('/api/organization/participant/documents/')) {
      return route.fulfill({
        body: '%PDF-1.7\nparticipant evidence',
        contentType: 'application/pdf',
        headers: {
          'content-disposition': 'attachment; filename="evidence.pdf"',
        },
      });
    }
    return route.fulfill({
      status: 403,
      json: { error: 'PARTICIPANT_SCOPE_REQUIRED' },
    });
  });
  await page.goto('/review.html?organization=1');
  await expect(page.getByRole('heading', { name: 'Team A' })).toBeVisible();
  await expect(page.getByText('No documents uploaded yet.')).toBeVisible();
  const input = page.getByLabel('Upload PDF or DOCX (maximum 2 MiB)');
  await expect(input).toBeVisible();
  await input.setInputFiles({
    name: 'evidence.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await page.getByRole('button', { name: 'Upload document' }).click();
  await expect(page.getByText('Version 1 · evidence.pdf')).toBeVisible();
  const download = page.getByRole('link', { name: 'Download evidence.pdf' });
  await expect(download).toHaveAttribute(
    'href',
    /\/api\/organization\/participant\/documents\/[a-f0-9-]{36}$/,
  );
  const downloadPromise = page.waitForEvent('download');
  await download.click();
  const downloadedFile = await downloadPromise;
  expect(downloadedFile.suggestedFilename()).toBe('evidence.pdf');
  await input.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not allowed'),
  });
  await expect(page.getByText('Choose a PDF or DOCX file.')).toBeVisible();
  await expect.poll(() => uploads).toHaveLength(1);
  await input.setInputFiles({
    name: 'large.pdf',
    mimeType: 'application/pdf',
    buffer: largePdf,
  });
  await expect(page.getByText('File must be 2 MiB or smaller.')).toBeVisible();
  await expect.poll(() => uploads).toHaveLength(1);
  await input.setInputFiles({
    name: 'revision.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await page.getByRole('button', { name: 'Upload document' }).click();
  await expect(page.getByText('Version 2 · revision.pdf')).toBeVisible();
  await expect(page.getByText('Version 1 · evidence.pdf')).toBeVisible();
  expect(uploads).toHaveLength(2);
});
