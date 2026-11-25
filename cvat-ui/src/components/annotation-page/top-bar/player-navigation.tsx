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
import { Chapter } from 'cvat-core/src/frames';
import { Job } from 'cvat-core-wrapper';
import { usePlugins } from 'utils/hooks';
import './frame-preview.scss';

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

interface HoverPreview {
    frame: number;
    left: number;
    imageData: ImageBitmap | Blob | null;
}

const HOVER_PREVIEW_CONTENT_WIDTH = 180;
const HOVER_PREVIEW_BOX_WIDTH = 196;
const HOVER_PREVIEW_DELAY = 120;

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
    const [hoverPreview, setHoverPreview] = useState<HoverPreview | null>(null);

    const frameFetching = useSelector(
        (state: CombinedState) => state.annotation.player.frame.fetching,
    );

    const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const previewTimeoutRef = useRef<number | null>(null);
    const previewRequestIdRef = useRef(0);
    const requestedFrameRef = useRef<number | null>(null);

    const playerSliderPlugins = usePlugins(
        (state: CombinedState) => state.plugins.components.annotationPage.player.slider,
        props,
    );

    const hideHoverPreview = useCallback((): void => {
        // Invalidate pending and in-flight preview requests.
        previewRequestIdRef.current += 1;
        requestedFrameRef.current = null;

        if (previewTimeoutRef.current !== null) {
            window.clearTimeout(previewTimeoutRef.current);
            previewTimeoutRef.current = null;
        }

        setHoverPreview(null);
    }, []);

    const onSliderMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
        console.log('[CVAT PREVIEW] Mouse detected', {
            playing,
            frameFetching,
            startFrame,
            stopFrame,
        });
        // Do not compete with the normal annotation frame decoder.
        if (playing || frameFetching || stopFrame <= startFrame) {
            return;
        }

        const rail = event.currentTarget.querySelector<HTMLElement>('.ant-slider-rail');
        if (!rail) {
            return;
        }

        const railRect = rail.getBoundingClientRect();
        const containerRect = event.currentTarget.getBoundingClientRect();
        if (!railRect.width || !containerRect.width) {
            return;
        }

        const ratio = clamp((event.clientX - railRect.left) / railRect.width, 0, 1);
        const frame = Math.round(startFrame + ratio * (stopFrame - startFrame));
        const halfPreviewWidth = HOVER_PREVIEW_BOX_WIDTH / 2;
        const left = clamp(
            event.clientX - containerRect.left,
            halfPreviewWidth,
            Math.max(halfPreviewWidth, containerRect.width - halfPreviewWidth),
        );

        setHoverPreview((current) => (
            current?.frame === frame
                ? { ...current, left }
                : { frame, left, imageData: null }
        ));

        // Moving within the same frame only repositions the tooltip.
        if (requestedFrameRef.current === frame) {
            return;
        }

        requestedFrameRef.current = frame;

        if (previewTimeoutRef.current !== null) {
            window.clearTimeout(previewTimeoutRef.current);
        }

        const requestId = ++previewRequestIdRef.current;
        previewTimeoutRef.current = window.setTimeout(async () => {
            previewTimeoutRef.current = null;

            console.log('[CVAT PREVIEW] Requesting frame:', frame);
            try {
                // Use CVAT's existing frame/chunk cache. This does not change the current frame.
                const frameData = await jobInstance.frames.get(frame, false, 1);
                const { imageData } = await frameData.data();
                console.log('[CVAT PREVIEW] Frame retrieved:', {
                    frame,
                    imageData,
                    type: imageData?.constructor?.name,
                });

                // Ignore results from older pointer positions or after navigation/playback starts.
                if (
                    previewRequestIdRef.current !== requestId ||
                    playing ||
                    frameFetching
                ) {
                    return;
                }

                setHoverPreview((current) => (
                    current?.frame === frame ? { ...current, imageData } : current
                ));
            } catch (error) {
                console.error('[CVAT PREVIEW] Frame retrieval failed:', error);
            }
            }
        }, HOVER_PREVIEW_DELAY);
    }, [frameFetching, jobInstance, playing, startFrame, stopFrame]);

    const previewImageData = hoverPreview?.imageData ?? null;

    useEffect(() => {
        if (!previewImageData || !previewCanvasRef.current) {
            return undefined;
        }

        let cancelled = false;

        const drawPreview = async (): Promise<void> => {
            const createdFromBlob = previewImageData instanceof Blob;
            const bitmap = createdFromBlob
                ? await createImageBitmap(previewImageData)
                : previewImageData;

            if (cancelled) {
                if (createdFromBlob) {
                    bitmap.close();
                }
                return;
            }

            const canvas = previewCanvasRef.current;
            const context = canvas?.getContext('2d');
            if (canvas && context) {
                const scale = Math.min(
                    1,
                    HOVER_PREVIEW_CONTENT_WIDTH / bitmap.width,
                    110 / bitmap.height,
                );
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            }

            // CVAT owns ImageBitmaps returned from its frame cache. Close only our Blob copy.
            if (createdFromBlob) {
                bitmap.close();
            }
        };

        drawPreview().catch(() => {
            // A failed preview render must not interrupt annotation.
        });

        return () => {
            cancelled = true;
        };
    }, [previewImageData]);

    useEffect(() => {
        if (playing || frameFetching) {
            hideHoverPreview();
        }
    }, [frameFetching, hideHoverPreview, playing]);

    useEffect(() => () => {
        previewRequestIdRef.current += 1;
        if (previewTimeoutRef.current !== null) {
            window.clearTimeout(previewTimeoutRef.current);
        }
    }, []);

    useEffect(() => {
        if (frameNumber !== frameInputValue) {
            setFrameInputValue(frameNumber);
        }
    }, [frameNumber]);

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
                    <Col style={{ position: 'relative' }}>
                        <div
                            className='cvat-player-slider-hover-area'
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
                            {hoverPreview && (
                                <div
                                    className='cvat-player-frame-preview'
                                    style={{ left: hoverPreview.left }}
                                >
                                    {hoverPreview.imageData ? (
                                        <canvas ref={previewCanvasRef} />
                                    ) : (
                                        <div className='cvat-player-frame-preview-placeholder'>
                                            Loading frame...
                                        </div>
                                    )}
                                    <span>Frame {hoverPreview.frame}</span>
                                </div>
                            )}
                            {!!ranges && (
                                <svg
                                    className='cvat-player-slider-progress'
                                    viewBox='0 0 1000 16'
                                    xmlns='http://www.w3.org/2000/svg'
                                >
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
                        </div>
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
