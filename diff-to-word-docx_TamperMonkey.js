// ==UserScript==
// @name         Download Diff as Word with Track Changes
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Download diff content as Word document with real OOXML track changes
// @author       You
// @match        *://diff.tcrouzet.com/*
// @match        *://crouzet.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cdn.jsdelivr.net
// ==/UserScript==

(function() {
    'use strict';

    function loadJSZip() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
                onload: function(response) {
                    if (response.status !== 200) { reject(new Error('Failed to load JSZip: HTTP ' + response.status)); return; }
                    try {
                        const script = unsafeWindow.document.createElement('script');
                        const blob = new Blob([response.responseText], { type: 'application/javascript' });
                        const blobUrl = URL.createObjectURL(blob);
                        script.src = blobUrl;
                        script.onload = () => { URL.revokeObjectURL(blobUrl); resolve(); };
                        script.onerror = () => reject(new Error('JSZip injection failed'));
                        unsafeWindow.document.head.appendChild(script);
                    } catch(e) { reject(e); }
                },
                onerror: () => reject(new Error('Network error loading JSZip'))
            });
        });
    }

    function addDownloadButton() {
        const footerItem = document.querySelector('.footerItemText');
        if (!footerItem) { setTimeout(addDownloadButton, 500); return; }
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `margin:20px 0;padding:15px;background:#f5f5f5;border:2px solid #0066cc;border-radius:8px;text-align:center;`;
        const button = document.createElement('button');
        button.textContent = '📥 Download as Word Document (with Track Changes)';
        button.style.cssText = `padding:12px 24px;background:#0066cc;color:white;border:none;border-radius:6px;font-size:16px;font-weight:bold;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:background 0.3s;`;
        button.onmouseover = () => button.style.background = '#0052a3';
        button.onmouseout = () => button.style.background = '#0066cc';
        buttonContainer.appendChild(button);
        footerItem.parentNode.insertBefore(buttonContainer, footerItem);
        return button;
    }

    async function init() {
        try { await loadJSZip(); console.log('JSZip loaded'); }
        catch (e) { console.error('Could not load JSZip:', e); return; }
        const tryAdd = () => { const b = addDownloadButton(); if (b) attachButtonHandler(b); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryAdd);
        else tryAdd();
    }

    init();

    function attachButtonHandler(button) {
        if (!button) return;
        button.addEventListener('click', async () => {
            try {
                button.textContent = '⏳ Generating...';
                button.disabled = true;
                await generateWordDocument();
                button.textContent = '✅ Downloaded!';
                setTimeout(() => { button.textContent = '📥 Download as Word (with Track Changes)'; button.disabled = false; }, 2000);
            } catch (error) {
                console.error('Error:', error);
                alert('Error generating document: ' + error.message);
                button.textContent = '❌ Error - Try Again';
                button.disabled = false;
            }
        });
    }

    function escXml(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
    }

    function buildDocumentXml(diffFragment) {
        const AUTHOR = 'Revision';
        const DATE = new Date().toISOString().split('.')[0] + 'Z';
        let revId = 1;

        const paragraphs = [[]];
        function currentPara() { return paragraphs[paragraphs.length - 1]; }
        function newPara() { paragraphs.push([]); }

        function pushRun(text) {
            if (!text) return;
            currentPara().push(`<w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`);
        }

        function pushIns(text) {
            if (!text) return;
            const id = revId++;
            currentPara().push(
                `<w:ins w:id="${id}" w:author="${escXml(AUTHOR)}" w:date="${DATE}">` +
                `<w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r>` +
                `</w:ins>`
            );
        }

        function pushDel(text) {
            if (!text) return;
            const id = revId++;
            currentPara().push(
                `<w:del w:id="${id}" w:author="${escXml(AUTHOR)}" w:date="${DATE}">` +
                `<w:r><w:delText xml:space="preserve">${escXml(text)}</w:delText></w:r>` +
                `</w:del>`
            );
        }

        // Collect the actual visible text from a node subtree.
        // wikEdDiffSpace contains a symbol span (skip) + a real text node with a space.
        // We collect only the real text nodes, ignoring wikEdDiffSpaceSymbol.
        function collectText(n) {
            if (n.nodeType === Node.TEXT_NODE) return n.textContent;
            if (n.nodeType !== Node.ELEMENT_NODE) return '';
            if (n.classList.contains('wikEdDiffSpaceSymbol')) return ''; // visual only, skip
            let result = '';
            for (const child of n.childNodes) result += collectText(child);
            return result;
        }

        // Process a node, with an inherited change type from a parent delete/insert span.
        // type: 'normal' | 'ins' | 'del'
        function processNode(n, type) {
            if (n.nodeType === Node.TEXT_NODE) {
                const text = n.textContent;
                if (!text) return;
                if (type === 'ins') pushIns(text);
                else if (type === 'del') pushDel(text);
                else pushRun(text);
                return;
            }

            if (n.nodeType !== Node.ELEMENT_NODE) return;

            const cl = n.classList;

            // Skip purely visual elements
            if (cl.contains('wikEdDiffSpaceSymbol')) return;

            // wikEdDiffMarkRight: phantom marker at the OLD position of moved text.
            // Its title attribute contains the moved text. Emit as a deletion so Word
            // shows "this text was removed from here" in the track changes pane.
            if (cl.contains('wikEdDiffMarkRight')) {
                const movedText = n.getAttribute('title');
                if (movedText && movedText.trim()) pushDel(movedText.trim());
                return;
            }

            // Newline → paragraph break (regardless of parent type)
            if (cl.contains('wikEdDiffNewline')) {
                newPara();
                return;
            }

            // wikEdDiffSpace: contains a symbol span + a real space text node.
            // Emit one space with the inherited type.
            if (cl.contains('wikEdDiffSpace')) {
                if (type === 'ins') pushIns(' ');
                else if (type === 'del') pushDel(' ');
                else pushRun(' ');
                return;
            }

            // Delete span (including wikEdDiffDeleteBlank — e.g. deleted spaces/letters)
            if (cl.contains('wikEdDiffDelete')) {
                // Recurse with type='del' so all children emit as deletions
                for (const child of n.childNodes) processNode(child, 'del');
                return;
            }

            // Insert span (including wikEdDiffInsertBlank — e.g. inserted spaces/letters)
            if (cl.contains('wikEdDiffInsert')) {
                for (const child of n.childNodes) processNode(child, 'ins');
                return;
            }

            // wikEdDiffBlock: moved text at NEW position → emit as insertion
            // Paired with the wikEdDiffMarkRight deletion above, Word will show
            // the text as deleted at the old spot and inserted at the new spot.
            if (cl.contains('wikEdDiffBlock')) {
                for (const child of n.childNodes) processNode(child, 'ins');
                return;
            }

            // Everything else: recurse with inherited type
            for (const child of n.childNodes) processNode(child, type);
        }

        for (const child of diffFragment.childNodes) processNode(child, 'normal');

        const parasXml = paragraphs.map(runs => {
            if (runs.length === 0) return '<w:p/>';
            return `<w:p><w:pPr><w:spacing w:after="200"/></w:pPr>${runs.join('')}</w:p>`;
        }).join('\n');

        const titleXml = `<w:p>
            <w:pPr><w:spacing w:after="400"/></w:pPr>
            <w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
            <w:t>Hausarbeit - Track Changes Version</w:t></w:r>
        </w:p>`;

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
            mc:Ignorable="w14">
  <w:body>
    ${titleXml}
    ${parasXml}
    <w:sectPr/>
  </w:body>
</w:document>`;
    }

    async function generateWordDocument() {
        const JSZip = unsafeWindow.JSZip;
        const diffContainer = document.querySelector('.wikEdDiffContainer');
        if (!diffContainer) throw new Error('Diff content not found on page');
        const diffFragment = diffContainer.querySelector('.wikEdDiffFragment');
        if (!diffFragment) throw new Error('Diff fragment not found');

        const documentXml = buildDocumentXml(diffFragment);
        console.log('Generated XML:', documentXml); // helpful for debugging

        const zip = new JSZip();
        zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
        zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`);
        zip.file('word/document.xml', documentXml);
        zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

        const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hausarbeit-track-changes.docx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

})();
