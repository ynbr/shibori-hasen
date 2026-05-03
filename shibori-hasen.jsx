#target illustrator

/*
  shibori-hasen.jsx  v0.1
  Illustrator JSX / ScriptUI modal dialog 版
  対応: Illustrator 30.x（macOS）

  - 選択パスを直線dashの集合に変換
  - モーダルdialogでパラメータ設定 → OKで一括変換
  - palette版で発生した macOS フォーカス問題を回避するためdialog方式
  - ライブプレビューは廃止。OK押下後に結果が表示される

  使い方:
    1. 破線化したいパスを選択
    2. File > Scripts > Other Script... で本ファイルを実行
    3. 数値・チェックボックスを調整して「OK」
    4. dashグループ "shibori-hasen-dashes" が生成され、元線は非表示
*/

(function () {
    if (app.documents.length === 0) {
        alert("ドキュメントが開かれていません。");
        return;
    }

    var doc = app.activeDocument;
    if (!doc.selection || doc.selection.length === 0) {
        alert("破線化したいパスを選択してください。");
        return;
    }

    var CONFIG = {
        targetDashMm: 7.0,
        targetGapMm: 2.0,
        unitToMm: 3.5278,
        roundCapCorrection: true,
        useRoundCap: true,

        minDashLength: 0.35,
        sampleStep: 0.08,

        useAnchorCornerDetection: true,
        anchorCornerAngle: 25,
        skipDashAcrossAnchorCorner: true,

        centerDashInPath: true,
        straightDash: true,

        hideOriginal: true,
        deleteOriginal: false,

        finalGroupName: "shibori-hasen-dashes",
        showReport: true
    };

    var originalSelection = [];
    for (var si = 0; si < doc.selection.length; si++) {
        originalSelection.push(doc.selection[si]);
    }

    // -------- UI: modal dialog --------
    var win = new Window("dialog", "絞り破線ジェネレーター");
    win.orientation = "column";
    win.alignChildren = "fill";
    win.spacing = 8;
    win.margins = 12;

    addTitle(win, "基本設定");
    var dashCtl = addSliderRow(win, "破線長 mm", CONFIG.targetDashMm, 1, 20, 2);
    var gapCtl = addSliderRow(win, "間隔 mm", CONFIG.targetGapMm, 0.1, 10, 2);
    var unitCtl = addNumberRow(win, "1 unit = mm", CONFIG.unitToMm, 4);
    var minCtl = addSliderRow(win, "minDash unit", CONFIG.minDashLength, 0.05, 2.0, 2);

    addTitle(win, "角処理");
    var anchorAngleCtl = addSliderRow(win, "anchor角度", CONFIG.anchorCornerAngle, 1, 120, 0);
    var useAnchorChk = win.add("checkbox", undefined, "アンカー角を検出する");
    useAnchorChk.value = CONFIG.useAnchorCornerDetection;
    var skipCornerChk = win.add("checkbox", undefined, "角をまたぐdashだけ描かない");
    skipCornerChk.value = CONFIG.skipDashAcrossAnchorCorner;

    addTitle(win, "線端・生成");
    var roundCapChk = win.add("checkbox", undefined, "線端を丸くする");
    roundCapChk.value = CONFIG.useRoundCap;
    var roundCorrectionChk = win.add("checkbox", undefined, "丸端補正を使う");
    roundCorrectionChk.value = CONFIG.roundCapCorrection;
    var centerChk = win.add("checkbox", undefined, "各パス内で破線を中央寄せする");
    centerChk.value = CONFIG.centerDashInPath;
    var hideOriginalChk = win.add("checkbox", undefined, "確定時に元線を非表示にする");
    hideOriginalChk.value = CONFIG.hideOriginal;

    var btnGroup = win.add("group");
    btnGroup.orientation = "row";
    btnGroup.alignChildren = "fill";
    var cancelBtn = btnGroup.add("button", undefined, "キャンセル", { name: "cancel" });
    var okBtn = btnGroup.add("button", undefined, "OK", { name: "ok" });

    if (win.show() !== 1) {
        return;
    }

    // -------- run --------
    readUIIntoConfig();

    if (!ensureDocReady()) return;

    var report = generateDashes(originalSelection);
    try { app.redraw(); } catch (e) {}

    if (report.errors && report.errors.length > 0) {
        alert("処理中にエラーが発生しました:\n" + report.errors.join("\n"));
    }

    if (report.created === 0) {
        alert(
            "dashが1本も生成できませんでした。\n\n" +
            "考えられる原因:\n" +
            "・パスが短すぎる\n" +
            "・角検出によって全dashがskipされた\n" +
            "・アクティブレイヤがロック/非表示\n\n" +
            "処理したパス: " + report.paths + " / skipped: " + report.skipped
        );
        return;
    }

    if (CONFIG.showReport) {
        alert(
            "破線化が完了しました。\n\n" +
            "処理したパス: " + report.paths + "\n" +
            "生成したdash: " + report.created + "\n" +
            "短すぎてスキップ: " + report.skipped + "\n" +
            "元線を保持: " + report.keptOriginal
        );
    }

    // ====================================================================
    // 以下、関数定義
    // ====================================================================

    function readUIIntoConfig() {
        CONFIG.targetDashMm = parseFloatSafe(dashCtl.input.text, CONFIG.targetDashMm);
        CONFIG.targetGapMm = parseFloatSafe(gapCtl.input.text, CONFIG.targetGapMm);
        CONFIG.unitToMm = parseFloatSafe(unitCtl.input.text, CONFIG.unitToMm);
        CONFIG.minDashLength = parseFloatSafe(minCtl.input.text, CONFIG.minDashLength);
        CONFIG.anchorCornerAngle = parseFloatSafe(anchorAngleCtl.input.text, CONFIG.anchorCornerAngle);
        CONFIG.useAnchorCornerDetection = useAnchorChk.value;
        CONFIG.skipDashAcrossAnchorCorner = skipCornerChk.value;
        CONFIG.useRoundCap = roundCapChk.value;
        CONFIG.roundCapCorrection = roundCorrectionChk.value;
        CONFIG.centerDashInPath = centerChk.value;
        CONFIG.hideOriginal = hideOriginalChk.value;

        if (CONFIG.targetDashMm <= 0) CONFIG.targetDashMm = 7.0;
        if (CONFIG.targetGapMm < 0) CONFIG.targetGapMm = 2.0;
        if (CONFIG.unitToMm <= 0) CONFIG.unitToMm = 3.5278;
        if (CONFIG.minDashLength < 0.01) CONFIG.minDashLength = 0.01;
        if (CONFIG.sampleStep <= 0) CONFIG.sampleStep = 0.08;
    }

    function ensureDocReady() {
        var layer = null;
        try { layer = doc.activeLayer; } catch (e) {}
        if (!layer) {
            alert("アクティブレイヤを取得できませんでした。");
            return false;
        }
        if (layer.locked) {
            alert("アクティブレイヤ「" + layer.name + "」がロックされています。\nロックを解除してから実行してください。");
            return false;
        }
        if (!layer.visible) {
            alert("アクティブレイヤ「" + layer.name + "」が非表示です。\n表示状態に戻してから実行してください。");
            return false;
        }
        return true;
    }

    function addTitle(parent, label) {
        var t = parent.add("statictext", undefined, label);
        try { t.graphics.font = ScriptUI.newFont(t.graphics.font.name, "BOLD", t.graphics.font.size); } catch (e) {}
        return t;
    }

    function addNumberRow(parent, label, defaultValue, decimals) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];

        var st = g.add("statictext", undefined, label);
        st.preferredSize.width = 95;

        var input = g.add("edittext", undefined, formatNumber(defaultValue, decimals));
        input.characters = 8;

        return { group: g, input: input };
    }

    function addSliderRow(parent, label, defaultValue, minValue, maxValue, decimals) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];

        var st = g.add("statictext", undefined, label);
        st.preferredSize.width = 95;

        var slider = g.add("slider", undefined, defaultValue, minValue, maxValue);
        slider.preferredSize.width = 140;

        var input = g.add("edittext", undefined, formatNumber(defaultValue, decimals));
        input.characters = 6;

        slider.onChanging = function () {
            input.text = formatNumber(slider.value, decimals);
        };
        slider.onChange = function () {
            input.text = formatNumber(slider.value, decimals);
        };
        input.onChange = function () {
            var v = parseFloatSafe(input.text, defaultValue);
            if (v < minValue) v = minValue;
            if (v > maxValue) v = maxValue;
            slider.value = v;
            input.text = formatNumber(v, decimals);
        };

        return { group: g, slider: slider, input: input };
    }

    function generateDashes(items) {
        var report = { paths: 0, created: 0, skipped: 0, keptOriginal: 0, errors: [] };

        var group = null;
        try {
            group = doc.groupItems.add();
            group.name = CONFIG.finalGroupName;
        } catch (eGrp) {
            report.errors.push("groupItems.add 失敗: " + eGrp);
            return report;
        }

        for (var i = 0; i < items.length; i++) {
            try {
                processItem(items[i], group, report);
            } catch (eItem) {
                report.errors.push("processItem[" + i + "] 失敗: " + eItem);
            }
        }

        if (report.created === 0) {
            try { group.remove(); } catch (e) {}
        }
        return report;
    }

    function processItem(item, group, report) {
        if (!item) return;
        if (item.typename === "PathItem") {
            processPathItem(item, group, report);
        } else if (item.typename === "CompoundPathItem") {
            var paths = [];
            for (var i = 0; i < item.pathItems.length; i++) paths.push(item.pathItems[i]);
            var before = report.created;
            for (i = 0; i < paths.length; i++) processPathItem(paths[i], group, report);
            if (report.created > before) hideOrDelete(item);
        } else if (item.typename === "GroupItem") {
            if (item.name === CONFIG.finalGroupName) return;
            var children = [];
            for (var j = 0; j < item.pageItems.length; j++) children.push(item.pageItems[j]);
            var beforeGroup = report.created;
            for (j = 0; j < children.length; j++) processItem(children[j], group, report);
            if (report.created > beforeGroup) hideOrDelete(item);
        }
    }

    function processPathItem(pathItem, group, report) {
        if (!pathItem || pathItem.pathPoints.length < 2) return;
        if (pathItem.guides || pathItem.clipping) return;
        report.paths++;

        var sampled = samplePathItem(pathItem, CONFIG.sampleStep);
        if (sampled.length < 2) { report.skipped++; return; }

        computeArcLength(sampled);
        var totalLength = sampled[sampled.length - 1].s;
        if (totalLength < CONFIG.minDashLength) { report.skipped++; return; }

        var anchorCorners = [];
        if (CONFIG.useAnchorCornerDetection) {
            anchorCorners = detectAnchorCorners(pathItem, sampled);
        }

        // 角でサブセグメントに分割。各セグメント内で centerDashInPath が
        // 独立に効くので、角の前後にも dash がきれいに収まる。
        // skipDashAcrossAnchorCorner OFF か corners が無ければ全長1セグメント。
        var segments = buildSegments(anchorCorners, totalLength);

        var before = report.created;
        for (var si = 0; si < segments.length; si++) {
            // 角はセグメント境界に置かれるため、内部の corner skip は不要
            drawDashedSegment(pathItem, sampled, segments[si], group, report);
        }

        if (report.created > before) {
            hideOrDelete(pathItem);
        } else {
            report.keptOriginal++;
        }
    }

    function buildSegments(anchorCorners, totalLength) {
        if (!CONFIG.skipDashAcrossAnchorCorner ||
            !anchorCorners || anchorCorners.length === 0) {
            return [{ start: 0, end: totalLength }];
        }
        var sorted = anchorCorners.slice().sort(function (a, b) { return a.s - b.s; });
        var segments = [];
        var prev = 0;
        var EPS = 0.0001;
        for (var i = 0; i < sorted.length; i++) {
            var s = sorted[i].s;
            if (s > prev + EPS && s < totalLength - EPS) {
                segments.push({ start: prev, end: s });
                prev = s;
            }
        }
        if (totalLength - prev > EPS) {
            segments.push({ start: prev, end: totalLength });
        }
        return segments;
    }

    function drawDashedSegment(originalPath, sampled, segment, group, report) {
        var segmentLength = segment.end - segment.start;
        if (segmentLength < CONFIG.minDashLength) return 0;

        var dashLength = getEffectiveDashLength(originalPath);
        var gapLength = getEffectiveGapLength(originalPath);
        if (dashLength <= 0) return 0;

        // 頂点（セグメント両端）を基準に dash を配置：
        //   dashLength は固定、gapLength を伸縮させてセグメント長に整合させる。
        //   centerDashInPath ON: 両端に adjGap/2 のマージンを置く（隣接セグメント
        //     のマージンと合わさって完全な gap になり、角・閉パスwraparound での
        //     dash 連結を防ぐ）。
        //   centerDashInPath OFF: 両端の dash がセグメント境界に接触する旧挙動。
        var sw = 0;
        try { sw = originalPath.strokeWidth || 0; } catch (eSw) {}
        // 視覚gapフロア: ユーザ指定の baseGap の半分、または絶対 0.5pt の大きい方。
        // round cap の場合 visible_gap = path_gap - sw なので、path 上の minGap は
        // visible フロア + sw とする（gapLength に既に sw 補正が入っているため
        // gapLength を使うと二重補正になり、正常な n が全て reject されてしまう）。
        var baseGap = mmToUnit(CONFIG.targetGapMm);
        var visibleGapFloor = Math.max(0.5, baseGap * 0.5);
        var minGap = visibleGapFloor + (CONFIG.useRoundCap ? sw : 0);
        var dashCount = chooseDashCount(segmentLength, dashLength, gapLength, minGap, CONFIG.centerDashInPath);
        if (dashCount < 1) return 0;

        var adjustedGap;
        var sideMargin;
        if (dashCount === 1) {
            adjustedGap = 0;
            sideMargin = CONFIG.centerDashInPath
                ? Math.max(0, (segmentLength - dashLength) / 2)
                : 0;
        } else if (CONFIG.centerDashInPath) {
            // 半gapマージン方式：n*(dashLength + adjGap) = segmentLength
            var slot = segmentLength / dashCount;
            adjustedGap = slot - dashLength;
            if (adjustedGap < 0) adjustedGap = 0;
            sideMargin = adjustedGap / 2;
        } else {
            // 旧挙動：両端の dash がセグメント境界に接する
            adjustedGap = (segmentLength - dashCount * dashLength) / (dashCount - 1);
            if (adjustedGap < 0) adjustedGap = 0;
            sideMargin = 0;
        }

        var createdCount = 0;
        var s = segment.start + sideMargin;

        for (var i = 0; i < dashCount; i++) {
            var dashStart = s;
            var dashEnd = Math.min(s + dashLength, segment.end);

            if (dashEnd - dashStart >= CONFIG.minDashLength) {
                var p0 = interpolateAtS(sampled, dashStart);
                var p1 = interpolateAtS(sampled, dashEnd);
                if (p0 && p1) {
                    createDashPath(originalPath, [p0, p1], group, report);
                    createdCount++;
                }
            }
            s += dashLength + adjustedGap;
        }
        return createdCount;
    }

    function chooseDashCount(segmentLength, dashLength, gapLength, minGap, centerMode) {
        // セグメントに dash を何本入れるか決める。
        // centerMode=true: 両端に adjGap/2 マージン → n*(dash+gap)=L 想定で n を推定
        // centerMode=false: 両端の dash が境界に接する → n*dash+(n-1)*gap=L 想定
        // 候補のうち target gap に最も近く、minGap を満たすものを採用。
        if (segmentLength < dashLength + 0.0001) {
            return segmentLength >= CONFIG.minDashLength ? 1 : 0;
        }
        var patternLength = dashLength + gapLength;
        var ideal = centerMode
            ? segmentLength / patternLength
            : (segmentLength + gapLength) / patternLength;
        var floorN = Math.max(1, Math.floor(ideal));
        var ceilN = Math.max(1, Math.ceil(ideal));

        if (minGap == null) minGap = gapLength > 0 ? gapLength * 0.5 : 0;

        var bestN = -1;
        var bestDelta = Infinity;
        var candidates = (floorN === ceilN) ? [floorN] : [floorN, ceilN];
        for (var k = 0; k < candidates.length; k++) {
            var n = candidates[k];
            if (n * dashLength > segmentLength + 0.0001) continue;
            if (n === 1) {
                // 1本配置: gap適合度は計測不能。2本目を入れたら minGap 未満に
                // なる、または2本入らない場合のみ採用。
                var twoSlotGap = centerMode
                    ? segmentLength / 2 - dashLength
                    : (segmentLength - 2 * dashLength);
                if (twoSlotGap < minGap || 2 * dashLength > segmentLength + 0.0001) {
                    var delta1 = Math.abs((segmentLength - dashLength) - gapLength);
                    if (delta1 < bestDelta) { bestDelta = delta1; bestN = 1; }
                }
            } else {
                var g = centerMode
                    ? segmentLength / n - dashLength
                    : (segmentLength - n * dashLength) / (n - 1);
                if (g < minGap) continue; // dash が連結して見える
                var delta = Math.abs(g - gapLength);
                if (delta < bestDelta) { bestDelta = delta; bestN = n; }
            }
        }
        // どの候補も不適なら最後の砦として n=1
        if (bestN < 1) bestN = 1;
        return bestN;
    }

    function createDashPath(originalPath, points, group, report) {
        var dash = group.pathItems.add();
        dash.stroked = true;
        dash.filled = false;
        dash.closed = false;
        dash.strokeWidth = originalPath.strokeWidth;

        // グラデーション/パターンストロークでの色継承失敗時は黒RGBにフォールバック
        var colorAssigned = false;
        try {
            dash.strokeColor = originalPath.strokeColor;
            colorAssigned = true;
        } catch (e1) {}
        if (!colorAssigned) {
            try {
                var fallback = new RGBColor();
                fallback.red = 0; fallback.green = 0; fallback.blue = 0;
                dash.strokeColor = fallback;
            } catch (eFb) {}
        }

        try { dash.opacity = originalPath.opacity; } catch (e2) {}
        try {
            if (CONFIG.useRoundCap) {
                dash.strokeCap = StrokeCap.ROUNDENDCAP;
            } else {
                dash.strokeCap = StrokeCap.BUTTENDCAP;
            }
        } catch (e3) {}
        try { dash.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e4) {}
        dash.setEntirePath(pointsToArray(points));
        report.created++;
        return dash;
    }

    function samplePathItem(pathItem, step) {
        var points = [];
        var pps = pathItem.pathPoints;
        var count = pps.length;
        var closed = pathItem.closed;
        for (var i = 0; i < count; i++) {
            if (!closed && i === count - 1) break;
            var p0 = pps[i];
            var p1 = pps[(i + 1) % count];
            var a0 = toPoint(p0.anchor);
            var h1 = toPoint(p0.rightDirection);
            var h2 = toPoint(p1.leftDirection);
            var a1 = toPoint(p1.anchor);
            var estimate = distance(a0, h1) + distance(h1, h2) + distance(h2, a1);
            if (estimate < 0.1) estimate = distance(a0, a1);
            var n = Math.max(2, Math.ceil(estimate / step));
            for (var j = 0; j < n; j++) {
                var t = j / n;
                var pt = cubicBezier(a0, h1, h2, a1, t);
                points.push({ x: pt.x, y: pt.y, s: 0 });
            }
        }
        if (!closed) {
            var last = pps[count - 1];
            points.push({ x: last.anchor[0], y: last.anchor[1], s: 0 });
        } else if (points.length > 0) {
            points.push({ x: points[0].x, y: points[0].y, s: 0 });
        }
        return removeDuplicatePoints(points);
    }

    function detectAnchorCorners(pathItem, sampled) {
        var corners = [];
        var pps = pathItem.pathPoints;
        var count = pps.length;
        var closed = pathItem.closed;
        for (var i = 0; i < count; i++) {
            if (!closed && (i === 0 || i === count - 1)) continue;
            var prevIndex = i - 1;
            var nextIndex = i + 1;
            if (prevIndex < 0) prevIndex = count - 1;
            if (nextIndex >= count) nextIndex = 0;

            var prev = toPoint(pps[prevIndex].anchor);
            var curr = toPoint(pps[i].anchor);
            var next = toPoint(pps[nextIndex].anchor);

            var v1 = { x: curr.x - prev.x, y: curr.y - prev.y };
            var v2 = { x: next.x - curr.x, y: next.y - curr.y };
            var angle = angleBetween(v1, v2);

            if (angle >= CONFIG.anchorCornerAngle) {
                var nearest = findNearestSamplePoint(sampled, curr);
                corners.push({ s: nearest.s, type: "hard", angle: angle, source: "anchor" });
            }
        }
        return corners;
    }

    function interpolateAtS(points, targetS) {
        if (targetS <= 0) return { x: points[0].x, y: points[0].y };
        for (var i = 1; i < points.length; i++) {
            var p0 = points[i - 1];
            var p1 = points[i];
            if (p0.s <= targetS && targetS <= p1.s) {
                var d = p1.s - p0.s;
                var t = d === 0 ? 0 : (targetS - p0.s) / d;
                return { x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) };
            }
        }
        var last = points[points.length - 1];
        return { x: last.x, y: last.y };
    }

    function computeArcLength(points) {
        points[0].s = 0;
        for (var i = 1; i < points.length; i++) {
            points[i].s = points[i - 1].s + distance(points[i - 1], points[i]);
        }
    }

    function hideOrDelete(item) {
        if (CONFIG.deleteOriginal) {
            try { item.remove(); } catch (e1) {}
        } else if (CONFIG.hideOriginal) {
            try { item.hidden = true; } catch (e2) {}
        }
    }

    function cubicBezier(p0, p1, p2, p3, t) {
        var mt = 1 - t;
        var mt2 = mt * mt;
        var t2 = t * t;
        return {
            x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
            y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y
        };
    }

    function removeDuplicatePoints(points) {
        if (points.length <= 1) return points;
        var result = [points[0]];
        for (var i = 1; i < points.length; i++) {
            if (distance(result[result.length - 1], points[i]) > 0.0001) result.push(points[i]);
        }
        return result;
    }

    function findNearestSamplePoint(sampled, target) {
        var nearest = sampled[0];
        var minDist = distance(sampled[0], target);
        for (var i = 1; i < sampled.length; i++) {
            var d = distance(sampled[i], target);
            if (d < minDist) {
                minDist = d;
                nearest = sampled[i];
            }
        }
        return nearest;
    }

    function mmToUnit(mm) {
        return mm / CONFIG.unitToMm;
    }

    function getEffectiveDashLength(originalPath) {
        var baseDash = mmToUnit(CONFIG.targetDashMm);
        if (CONFIG.roundCapCorrection && CONFIG.useRoundCap) {
            return Math.max(CONFIG.minDashLength, baseDash - originalPath.strokeWidth);
        }
        return baseDash;
    }

    function getEffectiveGapLength(originalPath) {
        var baseGap = mmToUnit(CONFIG.targetGapMm);
        if (CONFIG.roundCapCorrection && CONFIG.useRoundCap) {
            return baseGap + originalPath.strokeWidth;
        }
        return baseGap;
    }

    function toPoint(arr) { return { x: arr[0], y: arr[1] }; }

    function pointsToArray(points) {
        var arr = [];
        for (var i = 0; i < points.length; i++) arr.push([points[i].x, points[i].y]);
        return arr;
    }

    function distance(a, b) {
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function clamp(v, minValue, maxValue) { return Math.max(minValue, Math.min(maxValue, v)); }

    function angleBetween(v1, v2) {
        var len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
        var len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
        if (len1 === 0 || len2 === 0) return 0;
        var cosValue = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
        cosValue = clamp(cosValue, -1, 1);
        return Math.acos(cosValue) * 180 / Math.PI;
    }

    function parseFloatSafe(value, fallback) {
        var n = parseFloat(String(value).replace(",", "."));
        if (isNaN(n)) return fallback;
        return n;
    }

    function formatNumber(value, decimals) {
        var n = parseFloatSafe(value, 0);
        return n.toFixed(decimals);
    }
})();
