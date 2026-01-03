import { chromium } from 'playwright';
import { writeFile, mkdir, access, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { ScoutOutput, DOMSnapshot, ComputedStyleData, LayoutData, AssetData, AnimationData } from '@/lib/types';

export async function scoutNode(state: any): Promise<Partial<any>> {
  const { url, jobId } = state;
  
  console.log(`[Scout] Starting analysis of ${url}`);
  
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 }
    });
    
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    // CRITICAL: Wait for JavaScript to execute
    await page.waitForTimeout(3000);
    
    // ========================================================================
    // GHOST SCROLL: Trigger lazy loading
    // ========================================================================
    console.log('[Scout] Performing ghost scroll...');
    
    const totalHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = page.viewportSize()!.height;
    
    for (let y = 0; y < totalHeight; y += 100) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await page.waitForTimeout(500); // CRITICAL: 500ms to let lazy images load
    }
    
    await page.evaluate('window.scrollTo(0, 0)');
    await page.waitForTimeout(500);
    
    // ========================================================================
    // EXTRACT DOM STRUCTURE
    // ========================================================================
    console.log('[Scout] Extracting DOM structure...');
    
    const dom: DOMSnapshot = await page.evaluate(() => {
      function extractNode(element: Element): any {
        return {
          html: element.outerHTML.slice(0, 500), // Limit HTML length
          tag: element.tagName.toLowerCase(),
          selector: element.id ? `#${element.id}` : `.${Array.from(element.classList).join('.')}`,
          classes: Array.from(element.classList),
          textContent: element.textContent?.slice(0, 100) || '',
          children: Array.from(element.children).map(extractNode)
        };
      }
      
      return extractNode(document.body);
    });
    
    // ========================================================================
    // EXTRACT COMPUTED STYLES
    // ========================================================================
    console.log('[Scout] Extracting computed styles...');
    
    const computedStyles: ComputedStyleData[] = await page.evaluate(() => {
      const elements = document.querySelectorAll('*');
      const styleData: any[] = [];
      
      elements.forEach((el, index) => {
        const computed = window.getComputedStyle(el);
        
        if (computed.display === 'none' || computed.visibility === 'hidden') {
          return;
        }
        
        const selector = el.id 
          ? `#${el.id}` 
          : el.className 
            ? `.${Array.from(el.classList).join('.')}` 
            : `${el.tagName.toLowerCase()}:nth-child(${index})`;
        
        styleData.push({
          selector,
          styles: {
            display: computed.display,
            position: computed.position,
            width: computed.width,
            height: computed.height,
            padding: computed.padding,
            margin: computed.margin,
            color: computed.color,
            backgroundColor: computed.backgroundColor,
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            lineHeight: computed.lineHeight,
            flexDirection: computed.flexDirection,
            justifyContent: computed.justifyContent,
            alignItems: computed.alignItems,
            gridTemplateColumns: computed.gridTemplateColumns,
            gap: computed.gap,
            transition: computed.transition,
            animation: computed.animation,
            transform: computed.transform
          }
        });
      });
      
      return styleData;
    });
    
    // ========================================================================
    // EXTRACT LAYOUT DATA
    // ========================================================================
    console.log('[Scout] Extracting layout data...');
    
    const layout: LayoutData[] = await page.evaluate(() => {
      const elements = document.querySelectorAll('*');
      const layoutData: any[] = [];
      
      elements.forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        const computed = window.getComputedStyle(el);
        
        if (rect.width > 0 && rect.height > 0) {
          const selector = el.id 
            ? `#${el.id}` 
            : el.className 
              ? `.${Array.from(el.classList).join('.')}` 
              : `${el.tagName.toLowerCase()}:nth-child(${index})`;
          
          layoutData.push({
            selector,
            bbox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            },
            zIndex: parseInt(computed.zIndex) || 0
          });
        }
      });
      
      return layoutData;
    });
    
    // ========================================================================
    // ASSET HEIST: Download images (with cross-job caching)
    // ========================================================================
    console.log('[Scout] Downloading assets...');
    
    const assets: AssetData[] = [];
    
    // CRITICAL: Create directory structure
    const assetDir = join(process.cwd(), 'public', 'temp', 'assets', jobId);
    await mkdir(assetDir, { recursive: true });
    
    // Shared cache directory (reused across jobs)
    const cacheDir = join(process.cwd(), 'public', 'temp', 'assets', '_cache');
    await mkdir(cacheDir, { recursive: true });
    
    // Helper function to check if file exists
    const fileExists = async (path: string): Promise<boolean> => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    };
    
    // Helper function to generate filename from URL hash (consistent across jobs)
    const getCachedFilename = (url: string): string => {
      const urlHash = createHash('md5').update(url).digest('hex').substring(0, 12);
      const extension = url.split('.').pop()?.split('?')[0] || 'png';
      return `${urlHash}.${extension}`;
    };
    
    const images = await page.locator('img').all();
    let assetIndex = 0;
    
    for (let i = 0; i < Math.min(images.length, 20); i++) {
      const img = images[i];
      const src = await img.getAttribute('src');
      
      if (!src || src.startsWith('data:')) continue;
      
      try {
        const absoluteUrl = new URL(src, url).href;
        const cachedFilename = getCachedFilename(absoluteUrl);
        const cachePath = join(cacheDir, cachedFilename);
        const jobFilename = `img-${assetIndex.toString().padStart(3, '0')}-${cachedFilename}`;
        const jobPath = join(assetDir, jobFilename);
        const webPath = `/temp/assets/${jobId}/${jobFilename}`;
        
        // Check if asset exists in shared cache
        const cachedExists = await fileExists(cachePath);
        
        if (cachedExists) {
          // Copy from cache to job directory
          const cachedBuffer = await readFile(cachePath);
          await writeFile(jobPath, cachedBuffer);
          console.log(`[Scout] Using cached: ${absoluteUrl} -> ${webPath}`);
        } else {
          // Download and cache
          const response = await page.context().request.get(absoluteUrl);
          const buffer = await response.body();
          
          // Save to both cache and job directory
          await writeFile(cachePath, buffer);
          await writeFile(jobPath, buffer);
          console.log(`[Scout] Downloaded: ${absoluteUrl} -> ${webPath}`);
        }
        
        assets.push({
          type: 'image',
          originalUrl: absoluteUrl,
          localPath: webPath
        });
        assetIndex++;
      } catch (err) {
        console.warn(`[Scout] Failed to download image: ${src}`);
      }
    }
    
    // ========================================================================
    // DETECT ANIMATIONS
    // ========================================================================
    console.log('[Scout] Detecting animations...');
    
    const animations: AnimationData[] = await page.evaluate(() => {
      const elements = document.querySelectorAll('*');
      const animationData: any[] = [];
      
      elements.forEach((el, index) => {
        const computed = window.getComputedStyle(el);
        
        if (computed.transition && computed.transition !== 'all 0s ease 0s') {
          const selector = el.id 
            ? `#${el.id}` 
            : el.className 
              ? `.${Array.from(el.classList).join('.')}` 
              : `${el.tagName.toLowerCase()}:nth-child(${index})`;
          
          animationData.push({
            selector,
            type: 'css',
            properties: [{
              property: 'transition',
              from: '',
              to: '',
              duration: computed.transitionDuration,
              easing: computed.transitionTimingFunction,
              delay: computed.transitionDelay
            }]
          });
        }
        
        if (computed.animationName && computed.animationName !== 'none') {
          const selector = el.id 
            ? `#${el.id}` 
            : el.className 
              ? `.${Array.from(el.classList).join('.')}` 
              : `${el.tagName.toLowerCase()}:nth-child(${index})`;
          
          animationData.push({
            selector,
            type: 'css',
            properties: [{
              property: 'animation',
              from: '',
              to: '',
              duration: computed.animationDuration,
              easing: computed.animationTimingFunction,
              delay: computed.animationDelay
            }]
          });
        }
      });
      
      return animationData;
    });
    
    // ========================================================================
    // EXTRACT META DATA
    // ========================================================================
    console.log('[Scout] Extracting meta data...');
    
    const meta = await page.evaluate(() => {
      const getMetaContent = (name: string) => {
        const meta = document.querySelector(`meta[name="${name}"]`) ||
                     document.querySelector(`meta[property="${name}"]`);
        return meta?.getAttribute('content') || '';
      };
      
      return {
        title: document.title,
        description: getMetaContent('description'),
        viewport: getMetaContent('viewport'),
        theme: document.documentElement.classList.contains('dark') ? 'dark' as const : 'light' as const
      };
    });
    
    await browser.close();
    
    // ========================================================================
    // COMPILE SCOUT OUTPUT
    // ========================================================================
    const scoutOutput: ScoutOutput = {
      url,
      timestamp: new Date().toISOString(),
      dom,
      computedStyles,
      layout,
      assets,
      animations,
      breakpoints: {
        mobile: 375,
        tablet: 768,
        desktop: 1440
      },
      meta
    };
    
    console.log('[Scout] Analysis complete!');
    console.log(`  - DOM nodes: ${computedStyles.length}`);
    console.log(`  - Assets downloaded: ${assets.length}`);
    console.log(`  - Animations detected: ${animations.length}`);
    
    return {
      scoutData: scoutOutput,
      status: 'planning',
      currentNode: 'architect',
      decisionLog: [
        ...state.decisionLog,
        {
          timestamp: new Date().toISOString(),
          node: 'scout',
          decision: 'Completed website analysis',
          reasoning: `Extracted ${computedStyles.length} elements, ${assets.length} assets, ${animations.length} animations`
        }
      ]
    };
    
  } catch (error: any) {
    console.error('[Scout] Error:', error.message);
    
    return {
      status: 'failed',
      errors: [
        ...state.errors,
        {
          node: 'scout',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      ]
    };
  }
}
