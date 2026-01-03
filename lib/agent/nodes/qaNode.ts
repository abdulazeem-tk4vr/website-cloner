import { chromium } from 'playwright';
import { OpenAI } from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GeneratedCode, QAResult, ScoutOutput } from '@/lib/types';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { MODEL_CONFIG } from '@/lib/config';

// Fallback models for Gemini Vision (in order of preference)
const GEMINI_VISION_FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-pro-latest', 'gemini-2.0-flash-001'];

async function callVisionAPIWithFallback(promptText: string, originalBase64: string, generatedBase64: string, isGemini: boolean) {
  if (!isGemini) {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptText
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${originalBase64}`,
                detail: 'high'
              }
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${generatedBase64}`,
                detail: 'high'
              }
            }
          ]
        }
      ],
      max_tokens: 1000,
      temperature: 0.1
    });
    return response.choices[0].message.content || '{}';
  }
  
  const geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
  
  // Try models in order until one works
  for (const modelName of GEMINI_VISION_FALLBACK_MODELS) {
    try {
      const model = geminiAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        promptText,
        {
          inlineData: {
            data: originalBase64,
            mimeType: 'image/png'
          }
        },
        {
          inlineData: {
            data: generatedBase64,
            mimeType: 'image/png'
          }
        }
      ]);
      console.log(`[QA] Using model: ${modelName}`);
      return result.response.text();
    } catch (error: any) {
      // Check if it's a quota error
      if (error.message?.includes('429') || error.message?.includes('quota')) {
        console.warn(`[QA] Quota exceeded for ${modelName}, trying fallback...`);
        continue;
      }
      // For other errors, throw immediately
      throw error;
    }
  }
  throw new Error('All Gemini models exceeded quota or unavailable');
}

export async function qaNode(state: any): Promise<Partial<any>> {
  const { generatedCode, scoutData, jobId, retryCount, maxRetries } = state;
  
  console.log(`[QA] Validating (Attempt ${retryCount + 1}/${maxRetries})...`);
  
  try {
    // ========================================================================
    // STEP 1: Render generated code
    // ========================================================================
    console.log('[QA] Rendering generated code...');
    
    // Create temporary HTML with generated React code
    const tempHtmlPath = join(process.cwd(), 'public', 'temp', `${jobId}-preview.html`);
    
    // Extract App.tsx content
    const appContent = generatedCode.files['App.tsx'] || 
                      generatedCode.files['/App.tsx'] ||
                      generatedCode.files['app.tsx'] ||
                      Object.values(generatedCode.files).find((v: any) => 
                        typeof v === 'string' && (v.includes('export default') || v.includes('function App'))
                      ) as string || '';
    
    if (!appContent) {
      console.error('[QA] No App.tsx found. Available files:', Object.keys(generatedCode.files));
      throw new Error('No App.tsx content found in generated code');
    }
    
    console.log('[QA] App.tsx content length:', appContent.length);
    console.log('[QA] App.tsx preview:', appContent.slice(0, 200));
    
    // Get all component files for imports
    const allFiles = Object.entries(generatedCode.files)
      .filter(([key]) => key.endsWith('.tsx') || key.endsWith('.ts'))
      .map(([key, value]) => ({ name: key.replace(/^\//, ''), content: value as string }));
    
    // Create HTML that renders React code using Babel standalone
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generated Clone Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;
    
    // Include all component files
    ${allFiles.map(file => {
      let content = file.content;
      // Remove TypeScript-specific syntax that Babel can't handle
      content = content.replace(/:\s*\w+(\[\])?(\s*\|\s*\w+)*/g, '');
      content = content.replace(/<(\w+):\w+>/g, '<$1>');
      // Remove import statements (we'll handle them manually)
      content = content.replace(/import\s+.*?from\s+['"].*?['"];?\n?/g, '');
      return `// ${file.name}\n${content}`;
    }).join('\n\n')}
    
    // Render App component
    try {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      if (typeof App !== 'undefined') {
        root.render(React.createElement(App));
      } else {
        // Try to find default export
        const AppComponent = window.App || (typeof exports !== 'undefined' && exports.default) || null;
        if (AppComponent) {
          root.render(React.createElement(AppComponent));
        } else {
          throw new Error('App component not found');
        }
      }
    } catch (error) {
      document.getElementById('root').innerHTML = \`
        <div class="min-h-screen bg-red-50 p-8">
          <h1 class="text-2xl font-bold text-red-800 mb-4">Render Error</h1>
          <pre class="bg-red-100 p-4 rounded">\${error.toString()}</pre>
          <p class="mt-4 text-sm">Check console for details.</p>
        </div>
      \`;
      console.error('React render error:', error);
    }
  </script>
</body>
</html>`;

    await writeFile(tempHtmlPath, htmlContent);
    console.log('[QA] HTML file created at:', tempHtmlPath);
    
    // Launch browser and screenshot both
    const browser = await chromium.launch({ headless: true });
    
    // Screenshot generated
    const page1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page1.goto(`file://${tempHtmlPath}`);
    await page1.waitForTimeout(2000);
    const generatedScreenshot = await page1.screenshot({ fullPage: true });
    
    // Screenshot original
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page2.goto(scoutData.url, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    await page2.waitForTimeout(3000); // Give page time to render
    const originalScreenshot = await page2.screenshot({ fullPage: true });
    
    await browser.close();
    
    // ========================================================================
    // STEP 2: Vision API comparison (GPT-4o or Gemini)
    // ========================================================================
    console.log(`[QA] Comparing with ${MODEL_CONFIG.qaModel}...`);
    
    const originalBase64 = originalScreenshot.toString('base64');
    const generatedBase64 = generatedScreenshot.toString('base64');
    
    const promptText = `You are a QA engineer comparing two website screenshots.

IMAGE 1: Original website (what we're cloning)
IMAGE 2: Generated clone (our attempt)

Evaluate on these criteria. Return scores as NUMBERS (0-100), not strings or percentages:

1. STRUCTURAL SIMILARITY (40% weight)
   - Same sections (header, content, footer)?
   - Similar hierarchy?
   - Elements in similar positions?

2. VISUAL SIMILARITY (30% weight)
   - Colors close? (ignore exact hex, look for palette)
   - Typography similar?
   - Spacing similar?

3. LAYOUT ACCURACY (20% weight)
   - Grid/flex structure similar?
   - Proportions similar?

4. COLOR ACCURACY (10% weight)
   - Color palette matches?
   - Specific colors close to original?

CRITICAL: Return ONLY valid JSON. All metric values must be NUMBERS (0-100), not strings, percentages, or text.

OUTPUT ONLY THIS JSON (no markdown, no explanation, no code blocks):
{
  "metrics": {
    "structuralSimilarity": 85,
    "visualSimilarity": 90,
    "layoutAccuracy": 80,
    "colorAccuracy": 95
  },
  "issues": [
    {
      "severity": "major",
      "category": "layout",
      "description": "Footer positioned incorrectly",
      "suggestion": "Use sticky bottom positioning"
    }
  ],
  "overallAssessment": "Good match with minor spacing issues"
}

Be lenient on minor differences. Focus on overall structure. Ignore dynamic content.`;

    const isGemini = MODEL_CONFIG.qaModel === 'gemini';
    const gptResponse = await callVisionAPIWithFallback(promptText, originalBase64, generatedBase64, isGemini);
    
    // Parse JSON from response
    console.log('[QA] Raw LLM response length:', gptResponse.length);
    console.log('[QA] Raw LLM response preview:', gptResponse.slice(0, 500));
    
    const jsonMatch = gptResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[QA] No JSON found in response:', gptResponse);
      throw new Error(`Vision API failed to return valid JSON. Response: ${gptResponse.slice(0, 200)}`);
    }
    
    let gptResult: any;
    try {
      gptResult = JSON.parse(jsonMatch[0]);
      console.log('[QA] Parsed JSON:', JSON.stringify(gptResult, null, 2));
    } catch (parseError: any) {
      console.error('[QA] JSON parse error:', parseError.message);
      console.error('[QA] JSON string:', jsonMatch[0]);
      throw new Error(`Failed to parse JSON: ${parseError.message}`);
    }
    
    // Validate metrics exist
    if (!gptResult.metrics) {
      console.error('[QA] Missing metrics in response. Full response:', JSON.stringify(gptResult, null, 2));
      console.error('[QA] Available keys:', Object.keys(gptResult));
      throw new Error(`Vision API response missing metrics field. Response keys: ${Object.keys(gptResult).join(', ')}`);
    }
    
    const metrics = gptResult.metrics;
    console.log('[QA] Metrics received:', JSON.stringify(metrics, null, 2));
    console.log('[QA] Metrics type:', typeof metrics);
    console.log('[QA] Metrics keys:', Object.keys(metrics));
    
    // Validate and extract metric values (handle string or number)
    const getMetricValue = (value: any, name: string): number => {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        // Try to extract number from string (e.g., "85%" -> 85, "85/100" -> 85)
        const numMatch = value.match(/(\d+)/);
        if (numMatch) return parseInt(numMatch[1], 10);
      }
      console.warn(`[QA] Invalid ${name} value:`, value);
      return 0; // Default to 0 if invalid
    };
    
    // Check if metrics are in expected format
    const structuralSimilarity = getMetricValue(metrics.structuralSimilarity, 'structuralSimilarity');
    const visualSimilarity = getMetricValue(metrics.visualSimilarity, 'visualSimilarity');
    const layoutAccuracy = getMetricValue(metrics.layoutAccuracy, 'layoutAccuracy');
    const colorAccuracy = getMetricValue(metrics.colorAccuracy, 'colorAccuracy');
    
    console.log('[QA] Raw metric values:', {
      structuralSimilarity_raw: metrics.structuralSimilarity,
      visualSimilarity_raw: metrics.visualSimilarity,
      layoutAccuracy_raw: metrics.layoutAccuracy,
      colorAccuracy_raw: metrics.colorAccuracy
    });
    
    console.log('[QA] Parsed metrics:', {
      structuralSimilarity,
      visualSimilarity,
      layoutAccuracy,
      colorAccuracy
    });
    
    // Warn if all metrics are 0 (likely parsing issue)
    if (structuralSimilarity === 0 && visualSimilarity === 0 && layoutAccuracy === 0 && colorAccuracy === 0) {
      console.warn('[QA] WARNING: All metrics parsed to 0. This likely indicates a parsing issue.');
      console.warn('[QA] Original metrics object:', metrics);
    }
    
    // Calculate composite score
    const compositeScore = 
      (structuralSimilarity * 0.4) +
      (visualSimilarity * 0.3) +
      (layoutAccuracy * 0.2) +
      (colorAccuracy * 0.1);
    
    if (isNaN(compositeScore)) {
      console.error('[QA] Score calculation resulted in NaN. Metrics:', metrics);
      throw new Error(`Score calculation failed. Metrics: ${JSON.stringify(metrics)}`);
    }
    
    const qaResult: QAResult = {
      score: Math.round(compositeScore),
      passed: compositeScore >= 90,
      metrics: {
        structuralSimilarity,
        visualSimilarity,
        layoutAccuracy,
        colorAccuracy
      },
      screenshots: {
        original: originalBase64,
        generated: generatedBase64
      },
      issues: gptResult.issues || []
    };
    
    console.log('[QA] Validation complete!');
    console.log(`  - Score: ${qaResult.score}/100`);
    console.log(`  - Passed: ${qaResult.passed ? 'YES' : 'NO'}`);
    console.log(`  - Metrics breakdown:`);
    console.log(`    * Structural: ${qaResult.metrics.structuralSimilarity}`);
    console.log(`    * Visual: ${qaResult.metrics.visualSimilarity}`);
    console.log(`    * Layout: ${qaResult.metrics.layoutAccuracy}`);
    console.log(`    * Color: ${qaResult.metrics.colorAccuracy}`);
    if (qaResult.issues.length > 0) {
      console.log(`  - Issues found: ${qaResult.issues.length}`);
      qaResult.issues.forEach((issue, i) => {
        console.log(`    ${i + 1}. [${issue.severity || 'medium'}] ${issue.description}`);
        if (issue.suggestion) {
          console.log(`       → Fix: ${issue.suggestion}`);
        }
      });
    } else {
      console.log(`  - No issues found`);
    }
    
    // ========================================================================
    // STEP 3: Decide next step
    // ========================================================================
    
    const shouldRetry = !qaResult.passed && retryCount < maxRetries;
    
    if (qaResult.passed) {
      return {
        qaResult,
        status: 'complete',
        currentNode: null,
        completedAt: new Date().toISOString(),
        decisionLog: [
          ...state.decisionLog,
          {
            timestamp: new Date().toISOString(),
            node: 'qa',
            decision: 'Validation passed',
            reasoning: `Score: ${qaResult.score}/100`
          }
        ]
      };
    } else if (shouldRetry) {
      return {
        qaResult,
        status: 'coding',
        currentNode: 'coder',
        retryCount: retryCount + 1,
        attemptHistory: [
          ...state.attemptHistory,
          {
            attempt: retryCount + 1,
            qaScore: qaResult.score,
            issues: qaResult.issues.map(i => i.description),
            timestamp: new Date().toISOString()
          }
        ],
        decisionLog: [
          ...state.decisionLog,
          {
            timestamp: new Date().toISOString(),
            node: 'qa',
            decision: 'Retrying with fixes',
            reasoning: `Score: ${qaResult.score}/100 - Attempt ${retryCount + 1}/${maxRetries}`
          }
        ]
      };
    } else {
      return {
        qaResult,
        status: 'complete',
        currentNode: null,
        completedAt: new Date().toISOString(),
        decisionLog: [
          ...state.decisionLog,
          {
            timestamp: new Date().toISOString(),
            node: 'qa',
            decision: 'Max retries exhausted',
            reasoning: `Final score: ${qaResult.score}/100`
          }
        ]
      };
    }
    
  } catch (error: any) {
    console.error('[QA] Error:', error.message);
    
    return {
      status: 'failed',
      errors: [
        ...state.errors,
        {
          node: 'qa',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      ]
    };
  }
}
