import serverless from 'serverless-http';
import { createApp } from './app';

export const handler = serverless(createApp());
