// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import Text from 'antd/lib/typography/Text';
import { MoreOutlined } from '@ant-design/icons';
import Progress from 'antd/lib/progress';
import { Task, RQStatus, Request } from 'cvat-core-wrapper';
import Preview from 'components/common/preview';
import { ActiveInference } from 'reducers';
import StatusMessage from 'components/requests-page/request-status';
import { useContextMenuClick, useIsMounted } from 'utils/hooks';
import AutomaticAnnotationProgress from './automatic-annotation-progress';
import TaskActionsComponent from './actions-menu';

export interface TaskItemProps {
    taskInstance: any;
    deleted: boolean;
    activeInference: ActiveInference | null;
    activeRequest: Request | null;
    cancelAutoAnnotation(): void;
    updateTaskInState(task: Task): void;
    selected: boolean;
    onClick: () => void;
}

interface ImportingState {
    state: RQStatus | null;
    message: string;
    progress: number;
}

interface TaskJobStatus {
    stage?: string;
    state?: string;
}

interface JobsListResponse {
    results?: TaskJobStatus[];
    next?: string | null;
}

type TaskIndicatorStatus = 'empty' | 'new' | 'in-progress' | 'complete';

/**
 * Load all jobs belonging to one task. The jobs endpoint is paginated, so follow
 * the `next` link until all of the task's jobs have been retrieved.
 */
async function getTaskJobs(taskID: number, signal: AbortSignal): Promise<TaskJobStatus[]> {
    const jobs: TaskJobStatus[] = [];
    const query = new URLSearchParams({
        task_id: String(taskID),
        page_size: '100',
    });
    let nextURL: string | null = `/api/jobs?${query.toString()}`;

    while (nextURL) {
        const response = await fetch(nextURL, {
            credentials: 'same-origin',
            headers: {
                Accept: 'application/vnd.cvat+json',
            },
            signal,
        });

        if (!response.ok) {
            throw new Error(`Could not load jobs for task ${taskID}: HTTP ${response.status}`);
        }

        const payload = await response.json() as JobsListResponse | TaskJobStatus[];

        // Support both paginated responses and an unpaginated array response.
        if (Array.isArray(payload)) {
            jobs.push(...payload);
            nextURL = null;
        } else {
            if (Array.isArray(payload.results)) {
                jobs.push(...payload.results);
            }
            nextURL = payload.next ?? null;
        }
    }

    return jobs;
}

function normalizeJobValue(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/_/g, ' ');
}

/**
 * Resolve one indicator for the task from the stage/state pairs of its jobs.
 *
 * Priority for tasks containing multiple jobs:
 * 1. Any acceptance job in progress (or rejected) => in progress.
 * 2. Otherwise, any acceptance job new => new.
 * 3. Complete only when every job is acceptance/completed.
 * 4. An annotation/new job => empty.
 *
 * The task-level status is used as a fallback while the jobs request is pending
 * or when no job combination above applies (for example, a validation-stage job).
 */
function getTaskIndicatorStatus(
    jobs: TaskJobStatus[] | null,
    taskStatus: string,
): TaskIndicatorStatus {
    const fallbackStatus: TaskIndicatorStatus = taskStatus === 'completed'
        ? 'complete'
        : taskStatus === 'validation'
            ? 'in-progress'
            : 'empty';

    if (jobs === null || jobs.length === 0) {
        return fallbackStatus;
    }

    const acceptanceInProgress = jobs.some((job) => (
        normalizeJobValue(job.stage) === 'acceptance' &&
        ['in progress', 'rejected'].includes(normalizeJobValue(job.state))
    ));

    if (acceptanceInProgress) {
        return 'in-progress';
    }

    const acceptanceNew = jobs.some((job) => (
        normalizeJobValue(job.stage) === 'acceptance' &&
        normalizeJobValue(job.state) === 'new'
    ));

    if (acceptanceNew) {
        return 'new';
    }

    const allJobsAcceptedAndCompleted = jobs.every((job) => (
        normalizeJobValue(job.stage) === 'acceptance' &&
        normalizeJobValue(job.state) === 'completed'
    ));

    if (allJobsAcceptedAndCompleted) {
        return 'complete';
    }

    const hasAnnotationNewJob = jobs.some((job) => (
        normalizeJobValue(job.stage) === 'annotation' &&
        normalizeJobValue(job.state) === 'new'
    ));

    if (hasAnnotationNewJob) {
        return 'empty';
    }

    return fallbackStatus;
}

function TaskItemComponent(props: TaskItemProps): JSX.Element {
    const {
        taskInstance,
        deleted,
        activeInference,
        activeRequest,
        cancelAutoAnnotation,
        updateTaskInState,
        selected,
        onClick,
    } = props;

    const isMounted = useIsMounted();
    const {
        itemRef,
        handleContextMenuClick,
        handleContextMenuCapture,
    } = useContextMenuClick<HTMLDivElement>();

    const [importingState, setImportingState] = useState<ImportingState | null>(
        taskInstance.size > 0 ? null : {
            state: null,
            message: 'Request current progress',
            progress: 0,
        },
    );
    const [taskJobs, setTaskJobs] = useState<TaskJobStatus[] | null>(null);

    useEffect(() => {
        if (importingState !== null && activeRequest !== null) {
            setImportingState({
                message: activeRequest.message,
                progress: Math.floor((activeRequest.progress ?? 0) * 100),
                state: activeRequest.status,
            });

            taskInstance.listenToCreate(activeRequest.id, {
                callback: (request: Request) => {
                    if (isMounted()) {
                        setImportingState({
                            message: request.message,
                            progress: Math.floor((request.progress ?? 0) * 100),
                            state: request.status,
                        });
                    }
                },
                initialRequest: activeRequest,
            }).then((createdTask: Task) => {
                if (isMounted()) {
                    setImportingState(null);

                    setTimeout(() => {
                        if (isMounted() && taskInstance.size !== createdTask.size) {
                            updateTaskInState(createdTask);
                        }
                    }, 1000);
                }
            }).catch(() => {});
        }
    // This subscription is intentionally established once for the task item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const { id } = taskInstance;

    useEffect(() => {
        const controller = new AbortController();
        setTaskJobs(null);

        getTaskJobs(Number(id), controller.signal)
            .then((jobs) => {
                if (!controller.signal.aborted) {
                    setTaskJobs(jobs);
                }
            })
            .catch(() => {
                // Keep task-level status as a fallback if the jobs request fails.
                if (!controller.signal.aborted) {
                    setTaskJobs(null);
                }
            });

        return () => controller.abort();
    }, [id]);

    const style: React.CSSProperties = {};
    if (deleted) {
        style.pointerEvents = 'none';
        style.opacity = 0.5;
    }

    const owner = taskInstance.owner ? taskInstance.owner.username : null;
    const updated = dayjs(taskInstance.updatedDate).fromNow();
    const created = dayjs(taskInstance.createdDate).format('MMMM Do YYYY');
    const frameCount = Number(taskInstance.size ?? 0);
    const taskStatus = String(taskInstance.status ?? '').toLowerCase();
    const taskIndicatorStatus = getTaskIndicatorStatus(taskJobs, taskStatus);
    const taskIndicatorLabel: Record<TaskIndicatorStatus, string> = {
        empty: 'Empty',
        new: 'New',
        'in-progress': 'In progress',
        complete: 'Completed',
    };

    const progress = taskInstance.progress ?? {};
    const numOfJobs = Number(progress.totalJobs ?? 0);
    const numOfCompleted = Number(progress.completedJobs ?? 0);
    const numOfValidation = Number(progress.validationJobs ?? 0);
    const numOfAnnotation = Number(progress.annotationJobs ?? 0);
    const jobsProgress = numOfJobs > 0
        ? ((numOfCompleted + numOfValidation) * 100) / numOfJobs
        : 0;
    const completedProgress = numOfJobs > 0
        ? (numOfCompleted * 100) / numOfJobs
        : 0;

    const renderProgress = (): JSX.Element => {
        if (importingState) {
            return (
                <div className='cvat-task-card-progress-content'>
                    <StatusMessage
                        status={importingState.state}
                        message={importingState.message}
                    />
                    {importingState.state !== RQStatus.FAILED && (
                        <Progress
                            percent={importingState.progress}
                            strokeColor='#1890FF'
                            size='small'
                        />
                    )}
                </div>
            );
        }

        return (
            <div className='cvat-task-card-progress-content'>
                <div className='cvat-task-item-progress-labels'>
                    {numOfCompleted > 0 && (
                        <Text strong className='cvat-task-completed-progress'>
                            {`• ${numOfCompleted} done `}
                        </Text>
                    )}
                    {numOfValidation > 0 && (
                        <Text strong className='cvat-task-validation-progress'>
                            {`• ${numOfValidation} on review `}
                        </Text>
                    )}
                    {numOfAnnotation > 0 && (
                        <Text strong className='cvat-task-annotation-progress'>
                            {`• ${numOfAnnotation} annotating `}
                        </Text>
                    )}
                    <Text strong type='secondary'>
                        {`• ${numOfJobs} total`}
                    </Text>
                </div>
                <Progress
                    percent={jobsProgress}
                    success={{ percent: completedProgress }}
                    strokeColor='#1890FF'
                    showInfo={false}
                    size='small'
                />
                <AutomaticAnnotationProgress
                    activeInference={activeInference}
                    cancelAutoAnnotation={cancelAutoAnnotation}
                />
            </div>
        );
    };

    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
    const row = (
        <div
            ref={itemRef}
            className={`cvat-tasks-list-item cvat-task-card${selected ? ' cvat-item-selected' : ''}`}
            style={style}
            onClick={onClick}
            onContextMenuCapture={handleContextMenuCapture}
        >
            <div className='cvat-task-card-header'>
                <div className='cvat-task-card-status'>
                    <span
                        className={`cvat-task-status-dot cvat-task-status-${taskIndicatorStatus}`}
                        role='img'
                        aria-label={`Task status: ${taskIndicatorLabel[taskIndicatorStatus]}`}
                        title={taskIndicatorLabel[taskIndicatorStatus]}
                    />
                </div>

                <button
                    type='button'
                    className='cvat-task-card-actions'
                    title='Task actions'
                    aria-label='Task actions'
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        handleContextMenuClick(event);
                    }}
                >
                    <MoreOutlined />
                </button>
            </div>

            <Link
                to={`/tasks/${id}`}
                className='cvat-task-card-preview-link'
                aria-label={`Open task ${taskInstance.name}`}
                onClick={(event) => event.stopPropagation()}
            >
                <Preview
                    task={taskInstance}
                    loadingClassName='cvat-task-item-loading-preview'
                    emptyPreviewClassName='cvat-task-item-empty-preview'
                    previewWrapperClassName='cvat-task-item-preview-wrapper'
                    previewClassName='cvat-task-item-preview'
                />
            </Link>

            <div className='cvat-task-card-details'>
                <Link
                    to={`/tasks/${id}`}
                    className='cvat-task-card-title-link'
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className='cvat-task-card-title' title={taskInstance.name}>
                        <span className='cvat-task-card-id'>{`#${id}: `}</span>
                        <span className='cvat-task-card-name'>{taskInstance.name}</span>
                    </div>
                </Link>

                <div className='cvat-task-card-subtitle'>
                    {owner && <span>{`Created by ${owner} on ${created}`}</span>}
                    <span>{`Last updated ${updated}`}</span>
                </div>
            </div>

            <div className='cvat-task-card-progress'>
                {renderProgress()}
            </div>

            <div className='cvat-task-card-metadata'>
                <span>{`${frameCount.toLocaleString()} frames`}</span>
            </div>
        </div>
    );
    /* eslint-enable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */

    return (
        <TaskActionsComponent
            dropdownTrigger={['contextMenu']}
            taskInstance={taskInstance}
            triggerElement={row}
        />
    );
}

export default React.memo(TaskItemComponent);
