// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useState, useEffect, useCallback, useRef, CSSProperties,
} from 'react';
import { useSelector } from 'react-redux';

import { Row, Col } from 'antd/lib/grid';
import Icon, {
    LinkOutlined, DeleteOutlined, CopyOutlined, SearchOutlined,
} from '@ant-design/icons';
import Slider, { SliderMarks } from 'antd/lib/slider';
import InputNumber from 'antd/lib/input-number';
import Text from 'antd/lib/typography/Text';
import Modal from 'antd/lib/modal';
import message from 'antd/lib/message';
import Tooltip from 'antd/lib/tooltip';

import { Workspace, CombinedState } from 'reducers';
import { RestoreIcon } from 'icons';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import CVATTooltip from 'components/common/cvat-tooltip';
import { clamp } from 'utils/math';
import GlobalHotKeys, { KeyMap } from 'utils/mousetrap-react';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import { Job } from 'cvat-core-wrapper';
import { Chapter } from 'cvat-core/src/frames';
import { usePlugins } from 'utils/hooks';

interface Props {
    startFrame: number;
    stopFrame: number;
    playing: boolean;
    ranges: string;
    frameNumber: number;
    chapters: Chapter[] | null;
    hoveredChapter: number | null;
    frameFilename: string;
    frameDeleted: boolean;
    frameDeletionAvailable: boolean;
    deleteFrameShortcut: string;
    focusFrameInputShortcut: string;
    searchFrameByNameShortcut: string;
    showSearchFrameByName: boolean;
    inputFrameRef: React.RefObject<HTMLInputElement>;
    keyMap: KeyMap;
    workspace: Workspace;
    jobInstance: Job;
    onSliderChange(value: number): void;
    onInputChange(value: number): void;
    onURLIconClick(): void;
    onCopyFilenameIconClick(): void;
    onDeleteFrame(): void;
    onRestoreFrame(): void;
    switchNavigationBlocked(blocked: boolean): void;
    switchShowSearchPallet(visible: boolean): void;
}

interface HoverPreviewState {
    frame: number;
    left: number;
    src: string | null;
    failed: boolean;
}

const HOVER_PREVIEW_DELAY_MS = 120;
const HOVER_PREVIEW_WIDTH = 196;
const HOVER_PREVIEW_CACHE_SIZE = 60;
const HOVER_PREVIEW_TOLERANCE = 10;
const HOVER_PREVIEW_PREFETCH_DELAY_MS = 250;
const HOVER_PREVIEW_PREFETCH_COUNT = 2;

const componentShortcuts = {
    DELETE_FRAME: {
        name: 'Delete frame',
        description: 'Delete frame',
        sequences: ['alt+del'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
    FOCUS_INPUT_FRAME: {
        name: 'Focus input frame',
        description: 'Focus on the element to change the current frame',
        sequences: ['`'],
        displayedSequences: ['~'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
    SEARCH_FRAME_BY_NAME: {
        name: 'Search frame by name',
        description: 'Open search frame by name dialog',
        sequences: [],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
};

registerComponentShortcuts(componentShortcuts);

function PlayerNavigation(props: Props): JSX.Element {
    const {
        startFrame,
        stopFrame,
        chapters,
        hoveredChapter,
        playing,
        frameNumber,
        frameFilename,
        frameDeleted,
        frameDeletionAvailable,
        deleteFrameShortcut,
        focusFrameInputShortcut,
        searchFrameByNameShortcut,
        inputFrameRef,
        ranges,
        keyMap,
        workspace,
        jobInstance,
        onSliderChange,
        onInputChange,
        onURLIconClick,
        onCopyFilenameIconClick,
        onDeleteFrame,
        onRestoreFrame,
        switchNavigationBlocked,
        switchShowSearchPallet,
        showSearchFrameByName,
    } = props;

    const [frameInputValue, setFrameInputValue] = useState<number>(frameNumber);
    const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(null);

    const frameFetching = useSelector(
        (state: CombinedState) => state.annotation.player.frame.fetching,
    );

    const previewTimeoutRef = useRef<number | null>(null);
    const previewRequestRef = useRef<AbortController | null>(null);
    const pendingPreviewFrameRef = useRef<number | null>(null);
    const previewCacheRef = useRef<Map<number, string>>(new Map());
    const lastHoveredFrameRef = useRef<number | null>(null);
    const prefetchTimeoutRef = useRef<number | null>(null);
    const prefetchRequestRef = useRef<AbortController | null>(null);

    const playerSliderPlugins = usePlugins(
        (state: CombinedState) => state.plugins.components.annotationPage.player.slider,
        props,
    );

    useEffect(() => {
        if (frameNumber !== frameInputValue) {
            setFrameInputValue(frameNumber);
        }
    }, [frameNumber]);

    const hideHoverPreview = useCallback((): void => {
        if (previewTimeoutRef.current !== null) {
            window.clearTimeout(previewTimeoutRef.current);
            previewTimeoutRef.current = null;
        }

        previewRequestRef.current?.abort();
        previewRequestRef.current = null;
        pendingPreviewFrameRef.current = null;
        setHoverPreview(null);
    }, []);

    const cachePreviewSrc = useCallback((frame: number, src: string): void => {
        const cache = previewCacheRef.current;
        // Re-inserting moves the frame to the end of the Map, so the least
        // recently used entry is evicted first.
        cache.delete(frame);
        cache.set(frame, src);

        while (cache.size > HOVER_PREVIEW_CACHE_SIZE) {
            const [oldestFrame, oldestSrc] = cache.entries().next().value;
            cache.delete(oldestFrame);
            URL.revokeObjectURL(oldestSrc);
        }
    }, []);

    const cachedPreviewSrc = useCallback((frame: number): string | null => {
        const cache = previewCacheRef.current;
        const src = cache.get(frame);
        if (src === undefined) {
            return null;
        }

        cache.delete(frame);
        cache.set(frame, src);
        return src;
    }, []);

    const nearestCachedPreview = useCallback((frame: number): string | null => {
        const cache = previewCacheRef.current;
        let nearestFrame: number | null = null;
        for (const cachedFrame of cache.keys()) {
            if (Math.abs(cachedFrame - frame) > HOVER_PREVIEW_TOLERANCE) {
                continue;
            }

            if (nearestFrame === null
                || Math.abs(cachedFrame - frame) < Math.abs(nearestFrame - frame)
            ) {
                nearestFrame = cachedFrame;
            }
        }

        if (nearestFrame === null) {
            return null;
        }

        const src = cache.get(nearestFrame);
        if (src === undefined) {
            return null;
        }

        cache.delete(nearestFrame);
        cache.set(nearestFrame, src);
        return src;
    }, []);

    const fetchPreviewSrc = useCallback(async (
        frame: number,
        signal: AbortSignal,
    ): Promise<string | null> => {
        if (jobInstance.taskId === null) {
            return null;
        }

        // Single frame from the task data endpoint. The slider value is a task
        // frame number, and compressed quality keeps the preview cheap.
        const query = new URLSearchParams({
            type: 'frame',
            number: String(frame),
            quality: 'compressed',
        });

        const response = await fetch(`/api/tasks/${jobInstance.taskId}/data/?${query.toString()}`, {
            method: 'GET',
            credentials: 'same-origin',
            signal,
        });

        if (!response.ok) {
            return null;
        }

        const blob = await response.blob();
        if (signal.aborted || blob.size === 0) {
            return null;
        }

        return URL.createObjectURL(blob);
    }, [jobInstance]);

    const prefetchNeighbors = useCallback((frame: number, direction: number): void => {
        const neighbors: number[] = [];
        for (let offset = 1; offset <= HOVER_PREVIEW_PREFETCH_COUNT; offset += 1) {
            const neighbor = clamp(frame + direction * offset, startFrame, stopFrame);
            if (neighbor === frame
                || previewCacheRef.current.has(neighbor)
                || pendingPreviewFrameRef.current === neighbor
            ) {
                continue;
            }

            neighbors.push(neighbor);
        }

        if (!neighbors.length) {
            return;
        }

        const controller = new AbortController();
        prefetchRequestRef.current?.abort();
        prefetchRequestRef.current = controller;

        for (const neighbor of neighbors) {
            fetchPreviewSrc(neighbor, controller.signal).then((src) => {
                if (!controller.signal.aborted && src) {
                    cachePreviewSrc(neighbor, src);
                }
            }).catch(() => {
                // Prefetching is opportunistic; failures are silently ignored.
            });
        }
    }, [cachePreviewSrc, fetchPreviewSrc, startFrame, stopFrame]);

    const onSliderMouseMove = useCallback((event: React.MouseEvent<HTMLElement>): void => {
        // The preview must not compete with the main player frame loading.
        if (playing || frameFetching || stopFrame <= startFrame) {
            return;
        }

        const bounds = event.currentTarget.getBoundingClientRect();
        if (!bounds.width) {
            return;
        }

        const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
        const frame = Math.round(startFrame + ratio * (stopFrame - startFrame));
        const halfPreviewWidth = HOVER_PREVIEW_WIDTH / 2;
        const left = clamp(
            event.clientX - bounds.left,
            halfPreviewWidth,
            Math.max(halfPreviewWidth, bounds.width - halfPreviewWidth),
        );

        const exactSrc = cachedPreviewSrc(frame);
        // A nearby cached frame is shown immediately while the exact frame
        // loads; the tolerance is acceptable for a scrubbing preview.
        const nearestSrc = exactSrc ?? nearestCachedPreview(frame);
        setHoverPreview((current) => (
            current?.frame === frame
                ? { ...current, left }
                : { frame, left, src: nearestSrc, failed: false }
        ));

        const direction = lastHoveredFrameRef.current === null
            || lastHoveredFrameRef.current === frame
            ? 0
            : Math.sign(frame - lastHoveredFrameRef.current);
        lastHoveredFrameRef.current = frame;

        if (prefetchTimeoutRef.current !== null) {
            window.clearTimeout(prefetchTimeoutRef.current);
            prefetchTimeoutRef.current = null;
        }

        if (direction !== 0) {
            // The guard uses values captured at scheduling time; pressing Play
            // within the delay window can let the prefetch through, which
            // costs two extra frame decodes at most.
            prefetchTimeoutRef.current = window.setTimeout(() => {
                prefetchTimeoutRef.current = null;
                prefetchNeighbors(frame, direction);
            }, HOVER_PREVIEW_PREFETCH_DELAY_MS);
        }

        if (exactSrc || pendingPreviewFrameRef.current === frame) {
            return;
        }

        pendingPreviewFrameRef.current = frame;
        if (previewTimeoutRef.current !== null) {
            window.clearTimeout(previewTimeoutRef.current);
        }

        const controller = new AbortController();
        previewRequestRef.current?.abort();
        previewRequestRef.current = controller;

        previewTimeoutRef.current = window.setTimeout(async () => {
            previewTimeoutRef.current = null;
            try {
                const src = await fetchPreviewSrc(frame, controller.signal);
                if (controller.signal.aborted) {
                    return;
                }

                if (src) {
                    cachePreviewSrc(frame, src);
                }

                setHoverPreview((current) => {
                    if (current?.frame !== frame) {
                        return current;
                    }

                    return src ? { ...current, src } : { ...current, failed: true };
                });
            } catch {
                // Aborted requests are expected while the pointer moves on;
                // real failures only degrade the preview, never annotation.
                if (!controller.signal.aborted) {
                    setHoverPreview((current) => (
                        current?.frame === frame ? { ...current, failed: true } : current
                    ));
                }
            } finally {
                if (pendingPreviewFrameRef.current === frame) {
                    pendingPreviewFrameRef.current = null;
                }
            }
        }, HOVER_PREVIEW_DELAY_MS);
    }, [
        cachedPreviewSrc, cachePreviewSrc, fetchPreviewSrc, nearestCachedPreview,
        prefetchNeighbors, frameFetching, playing, startFrame, stopFrame,
    ]);

    useEffect(() => {
        if (playing || frameFetching) {
            hideHoverPreview();
        }
    }, [frameFetching, hideHoverPreview, playing]);

    useEffect(() => () => {
        if (previewTimeoutRef.current !== null) {
            window.clearTimeout(previewTimeoutRef.current);
        }

        if (prefetchTimeoutRef.current !== null) {
            window.clearTimeout(prefetchTimeoutRef.current);
        }

        previewRequestRef.current?.abort();
        prefetchRequestRef.current?.abort();
        for (const src of previewCacheRef.current.values()) {
            URL.revokeObjectURL(src);
        }
    }, []);

    const showDeleteFrameDialog = useCallback(() => {
        if (!playing) {
            switchNavigationBlocked(true);
            Modal.confirm({
                title: `Do you want to delete frame #${frameNumber}?`,
                content: 'The frame will not be visible in navigation and exported datasets, but it still can be restored with all the annotations.',
                className: 'cvat-modal-delete-frame',
                okText: 'Delete',
                okType: 'danger',
                onOk: () => {
                    switchNavigationBlocked(false);
                    onDeleteFrame();
                },
                afterClose: () => {
                    switchNavigationBlocked(false);
                },
            });
        }
    }, [playing, frameNumber]);

    const handlers: Record<keyof typeof componentShortcuts, (event?: KeyboardEvent) => void> = {
        DELETE_FRAME: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            if (frameDeletionAvailable) {
                onDeleteFrame();
            } else {
                message.warning({
                    content: 'Frames cannot be deleted in replica jobs, use the parent annotation job',
                    className: 'cvat-replica-frame-deletion-warning',
                });
            }
        },
        FOCUS_INPUT_FRAME: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            if (inputFrameRef.current) {
                inputFrameRef.current.focus();
            }
        },
        SEARCH_FRAME_BY_NAME: (event: KeyboardEvent | undefined) => {
            if (showSearchFrameByName) {
                event?.preventDefault();
                switchShowSearchPallet(true);
            }
        },
    };

    const onSearchIconClick = useCallback(() => {
        switchShowSearchPallet(true);
    }, [switchShowSearchPallet]);

    const deleteFrameIconStyle: CSSProperties = workspace === Workspace.SINGLE_SHAPE ? {
        pointerEvents: 'none',
        opacity: 0.5,
    } : {};

    const marks: SliderMarks = (chapters ?? []).reduce<SliderMarks>((acc, chapter) => {
        const active = hoveredChapter === chapter.id;
        const innerAcc = acc ?? {};
        innerAcc[chapter.start] = {
            label:
                    <Tooltip title={`${chapter.metadata.title}`}>
                        <span className={`ant-slider-mark-chapter ${active ? 'active' : ''}`} />
                    </Tooltip>,
        };
        return innerAcc;
    }, {});

    const deleteFrameIcon = !frameDeleted ? (
        <CVATTooltip title={`Delete the frame ${deleteFrameShortcut}`}>
            <DeleteOutlined
                style={deleteFrameIconStyle}
                className='cvat-player-delete-frame'
                onClick={showDeleteFrameDialog}
            />
        </CVATTooltip>
    ) : (
        <CVATTooltip title='Restore the frame'>
            <Icon
                style={deleteFrameIconStyle}
                className='cvat-player-restore-frame'
                onClick={onRestoreFrame}
                component={RestoreIcon}
            />
        </CVATTooltip>
    );

    return (
        <>
            { workspace !== Workspace.SINGLE_SHAPE && (
                <GlobalHotKeys keyMap={subKeyMap(componentShortcuts, keyMap)} handlers={handlers} />
            )}
            <Col className='cvat-player-controls'>
                <Row align='bottom'>
                    <Col
                        style={{ position: 'relative' }}
                        onMouseMove={onSliderMouseMove}
                        onMouseLeave={hideHoverPreview}
                    >
                        <Slider
                            className='cvat-player-slider'
                            min={startFrame}
                            max={stopFrame}
                            marks={marks}
                            value={frameNumber || 0}
                            onChange={workspace !== Workspace.SINGLE_SHAPE ? onSliderChange : undefined}
                        />
                        {!!ranges && (
                            <svg className='cvat-player-slider-progress' viewBox='0 0 1000 16' xmlns='http://www.w3.org/2000/svg'>
                                {ranges.split(';').map((range) => {
                                    const [rangeStart, rangeStop] = range.split(':').map((num) => +num);
                                    const totalSegments = stopFrame - startFrame + 1;
                                    const segmentWidth = 1000 / totalSegments;
                                    const width = (rangeStop - rangeStart + 1) * segmentWidth;
                                    const offset = (Math.max((rangeStart - startFrame), 0) / totalSegments) * 1000;
                                    return (
                                        <rect rx={10} key={rangeStart} x={offset} y={0} height={16} width={width} />
                                    );
                                })}
                            </svg>
                        )}
                        {playerSliderPlugins
                            .sort((a, b) => a.weight - b.weight)
                            .map(({ component: Component }, index) => {
                                const ComponentToRender = Component as React.ComponentType<any>;
                                return <ComponentToRender key={index} targetProps={props} />;
                            })}
                        {hoverPreview && (
                            <div
                                className='cvat-player-frame-preview'
                                style={{ left: hoverPreview.left }}
                            >
                                {hoverPreview.src ? (
                                    <img
                                        src={hoverPreview.src}
                                        alt={`Frame ${hoverPreview.frame}`}
                                        draggable={false}
                                    />
                                ) : (
                                    <div className='cvat-player-frame-preview-placeholder'>
                                        {hoverPreview.failed ? 'Preview unavailable' : 'Loading frame...'}
                                    </div>
                                )}
                                <span>{`Frame ${hoverPreview.frame}`}</span>
                            </div>
                        )}
                    </Col>
                </Row>
                <Row justify='center'>
                    <Col className='cvat-player-filename-wrapper'>
                        <CVATTooltip title={`${frameFilename}`}>
                            <Text type='secondary'>{frameFilename}</Text>
                        </CVATTooltip>
                    </Col>
                    <Col className='cvat-player-frame-actions' offset={1}>
                        <CVATTooltip title='Copy frame filename'>
                            <CopyOutlined className='cvat-player-copy-frame-name-icon' onClick={onCopyFilenameIconClick} />
                        </CVATTooltip>
                        <CVATTooltip title='Create frame URL'>
                            <LinkOutlined className='cvat-player-frame-url-icon' onClick={onURLIconClick} />
                        </CVATTooltip>
                        { frameDeletionAvailable && deleteFrameIcon }
                    </Col>
                </Row>
            </Col>
            <Col>
                <CVATTooltip title={`Press ${focusFrameInputShortcut} to focus here`}>
                    <InputNumber
                        ref={inputFrameRef}
                        className='cvat-player-frame-selector'
                        type='number'
                        disabled={workspace === Workspace.SINGLE_SHAPE}
                        value={frameInputValue}
                        min={startFrame}
                        max={stopFrame}
                        style={{ ['--frame-input-width' as string]: `${stopFrame.toString().length + 2}ch` }}
                        onChange={(value: number | undefined | string | null) => {
                            if (typeof value !== 'undefined' && value !== null) {
                                setFrameInputValue(Math.floor(clamp(+value, startFrame, stopFrame)));
                            }
                        }}
                        onFocus={() => inputFrameRef.current?.select()}
                        onBlur={() => {
                            onInputChange(frameInputValue);
                        }}
                        onPressEnter={() => {
                            onInputChange(frameInputValue);
                        }}
                    />
                </CVATTooltip>
            </Col>
            <Col className='cvat-player-actions'>
                {
                    showSearchFrameByName && (
                        <CVATTooltip title={`Search frame by name ${searchFrameByNameShortcut}`}>
                            <SearchOutlined
                                className='cvat-player-search-frame-name-icon'
                                onClick={onSearchIconClick}
                            />
                        </CVATTooltip>
                    )
                }
            </Col>
        </>
    );
}

export default React.memo(PlayerNavigation);