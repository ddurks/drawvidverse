"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatchmakerStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const apigatewayv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigatewayv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
class MatchmakerStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ========================================================================
        // DynamoDB Table
        // ========================================================================
        const table = new dynamodb.Table(this, 'DrawvidVerseTable', {
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
        });
        // ========================================================================
        // JWT Secret
        // ========================================================================
        const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
            secretName: 'drawvidverse/jwt-secret',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({}),
                generateStringKey: 'secret',
                excludePunctuation: true,
                passwordLength: 64,
            },
        });
        // ========================================================================
        // VPC
        // ========================================================================
        const vpc = new ec2.Vpc(this, 'DrawvidVerseVpc', {
            maxAzs: 2,
            natGateways: 0, // No NAT gateway needed (public subnets only)
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });
        // ========================================================================
        // ECS Cluster
        // ========================================================================
        const cluster = new ecs.Cluster(this, 'DrawvidVerseCluster', {
            vpc,
            clusterName: 'drawvidverse-cluster',
        });
        // ========================================================================
        // ECR Repository for world server
        // ========================================================================
        const worldserverRepo = new ecr.Repository(this, 'WorldserverRepo', {
            repositoryName: 'drawvidverse-worldserver',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });
        // ========================================================================
        // Security Group for world server tasks
        // ========================================================================
        const worldserverSecurityGroup = new ec2.SecurityGroup(this, 'WorldserverSecurityGroup', {
            vpc,
            description: 'Security group for world server tasks',
            allowAllOutbound: true,
        });
        // Allow inbound on port 7777 (WebSocket)
        worldserverSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7777), 'Allow world server WebSocket connections');
        // ========================================================================
        // ECS Task Definition
        // ========================================================================
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'WorldserverTaskDef', {
            memoryLimitMiB: 512,
            cpu: 256,
        });
        // Grant task permission to stop itself
        taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['ecs:StopTask'],
            resources: ['*'],
        }));
        // Grant task permission to read/write bootstrap in DynamoDB
        table.grantReadWriteData(taskDefinition.taskRole);
        const worldserverContainer = taskDefinition.addContainer('worldserver', {
            image: ecs.ContainerImage.fromEcrRepository(worldserverRepo, 'latest'),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'worldserver',
                logRetention: logs.RetentionDays.ONE_WEEK,
            }),
            environment: {
                DDB_TABLE: table.tableName,
                WORLD_STORE_MODE: 'dynamodb',
            },
            // Secrets and other env vars will be passed via RunTask overrides
        });
        worldserverContainer.addPortMappings({
            containerPort: 7777,
            protocol: ecs.Protocol.TCP,
        });
        // ========================================================================
        // Lambda Functions
        // ========================================================================
        const lambdaEnv = {
            TABLE_NAME: table.tableName,
            ECS_CLUSTER_ARN: cluster.clusterArn,
            TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
            SUBNETS: vpc.publicSubnets.map((s) => s.subnetId).join(','),
            SECURITY_GROUP: worldserverSecurityGroup.securityGroupId,
            JWT_SECRET: jwtSecret.secretValue.unsafeUnwrap(), // In production, use fromSecretsManager
        };
        const connectHandler = new lambda.Function(this, 'ConnectHandler', {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset('../dist/lambdas'),
            handler: 'connect.handler',
            environment: lambdaEnv,
            timeout: cdk.Duration.seconds(10),
        });
        const disconnectHandler = new lambda.Function(this, 'DisconnectHandler', {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset('../dist/lambdas'),
            handler: 'disconnect.handler',
            environment: lambdaEnv,
            timeout: cdk.Duration.seconds(10),
        });
        const defaultHandler = new lambda.Function(this, 'DefaultHandler', {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset('../dist/lambdas'),
            handler: 'default.handler',
            environment: lambdaEnv,
            timeout: cdk.Duration.seconds(10),
        });
        const messageHandler = new lambda.Function(this, 'MessageHandler', {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset('../dist/lambdas'),
            handler: 'message.handler',
            environment: lambdaEnv,
            timeout: cdk.Duration.seconds(300), // Long timeout for task launch
        });
        // Grant permissions
        table.grantReadWriteData(connectHandler);
        table.grantReadWriteData(disconnectHandler);
        table.grantReadWriteData(defaultHandler);
        table.grantReadWriteData(messageHandler);
        jwtSecret.grantRead(messageHandler);
        // Grant ECS permissions to message handler
        messageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'ecs:RunTask',
                'ecs:DescribeTasks',
                'ec2:DescribeNetworkInterfaces',
                'iam:PassRole',
            ],
            resources: ['*'],
        }));
        // ========================================================================
        // WebSocket API
        // ========================================================================
        const webSocketApi = new apigatewayv2.WebSocketApi(this, 'DrawvidVerseWsApi', {
            apiName: 'drawvidverse-lobby',
            connectRouteOptions: {
                integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('ConnectIntegration', connectHandler),
            },
            disconnectRouteOptions: {
                integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('DisconnectIntegration', disconnectHandler),
            },
            defaultRouteOptions: {
                integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('DefaultIntegration', defaultHandler),
            },
        });
        // Add message routes
        webSocketApi.addRoute('createWorld', {
            integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('CreateWorldIntegration', messageHandler),
        });
        webSocketApi.addRoute('joinWorld', {
            integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('JoinWorldIntegration', messageHandler),
        });
        webSocketApi.addRoute('leaveWorld', {
            integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('LeaveWorldIntegration', messageHandler),
        });
        webSocketApi.addRoute('ping', {
            integration: new apigatewayv2Integrations.WebSocketLambdaIntegration('PingIntegration', defaultHandler),
        });
        const stage = new apigatewayv2.WebSocketStage(this, 'ProdStage', {
            webSocketApi,
            stageName: 'prod',
            autoDeploy: true,
        });
        // Grant API Gateway invoke permissions to lambdas
        const apiGatewayManagementEndpoint = `https://${webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/${stage.stageName}`;
        [connectHandler, disconnectHandler, defaultHandler, messageHandler].forEach((fn) => {
            fn.addEnvironment('WEBSOCKET_ENDPOINT', apiGatewayManagementEndpoint);
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: ['execute-api:ManageConnections'],
                resources: [
                    `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${stage.stageName}/*`,
                ],
            }));
        });
        // ========================================================================
        // Outputs
        // ========================================================================
        new cdk.CfnOutput(this, 'WebSocketApiUrl', {
            value: stage.url,
            description: 'WebSocket API URL',
        });
        new cdk.CfnOutput(this, 'DdbTableName', {
            value: table.tableName,
            description: 'DynamoDB table name',
        });
        new cdk.CfnOutput(this, 'ClusterArn', {
            value: cluster.clusterArn,
            description: 'ECS Cluster ARN',
        });
        new cdk.CfnOutput(this, 'TaskDefinitionArn', {
            value: taskDefinition.taskDefinitionArn,
            description: 'ECS Task Definition ARN',
        });
        new cdk.CfnOutput(this, 'WorldserverRepoUri', {
            value: worldserverRepo.repositoryUri,
            description: 'ECR repository URI for world server',
        });
    }
}
exports.MatchmakerStack = MatchmakerStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWF0Y2htYWtlci1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1hdGNobWFrZXItc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLG1FQUFxRDtBQUNyRCx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsMkRBQTZDO0FBQzdDLCtEQUFpRDtBQUNqRCwyRUFBNkQ7QUFDN0Qsb0dBQXNGO0FBQ3RGLCtFQUFpRTtBQUlqRSxNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QiwyRUFBMkU7UUFDM0UsaUJBQWlCO1FBQ2pCLDJFQUEyRTtRQUMzRSxNQUFNLEtBQUssR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzFELFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ2pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQzVELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLHdCQUF3QjtTQUNuRSxDQUFDLENBQUM7UUFFSCwyRUFBMkU7UUFDM0UsYUFBYTtRQUNiLDJFQUEyRTtRQUMzRSxNQUFNLFNBQVMsR0FBRyxJQUFJLGNBQWMsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZ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SyxDQUFDLFNBQVMsSUFBSTtpQkFDaEc7YUFDRixDQUFDLENBQ0gsQ0FBQztRQUNKLENBQUMsQ0FBQyxDQUFDO1FBRUgsMkVBQTJFO1FBQzNFLFVBQVU7UUFDViwyRUFBMkU7UUFDM0UsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDaEIsV0FBVyxFQUFFLG1CQUFtQjtTQUNqQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUN0QyxLQUFLLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDdEIsV0FBVyxFQUFFLHFCQUFxQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFVBQVU7WUFDekIsV0FBVyxFQUFFLGlCQUFpQjtTQUMvQixDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzNDLEtBQUssRUFBRSxjQUFjLENBQUMsaUJBQWlCO1lBQ3ZDLFdBQVcsRUFBRSx5QkFBeUI7U0FDdkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUM1QyxLQUFLLEVBQUUsZUFBZSxDQUFDLGFBQWE7WUFDcEMsV0FBVyxFQUFFLHFDQUFxQztTQUNuRCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFqU0QsMENBaVNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXl2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXl2MkludGVncmF0aW9ucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9ucyc7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XG5cbmV4cG9ydCBjbGFzcyBNYXRjaG1ha2VyU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEcmF3dmlkVmVyc2VUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAncGsnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnc2snLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIENoYW5nZSBmb3IgcHJvZHVjdGlvblxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSldUIFNlY3JldFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGp3dFNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0p3dFNlY3JldCcsIHtcbiAgICAgIHNlY3JldE5hbWU6ICdkcmF3dmlkdmVyc2Uvand0LXNlY3JldCcsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoe30pLFxuICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ3NlY3JldCcsXG4gICAgICAgIGV4Y2x1ZGVQdW5jdHVhdGlvbjogdHJ1ZSxcbiAgICAgICAgcGFzc3dvcmRMZW5ndGg6IDY0LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFZQQ1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdEcmF3dmlkVmVyc2VWcGMnLCB7XG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMCwgLy8gTm8gTkFUIGdhdGV3YXkgbmVlZGVkIChwdWJsaWMgc3VibmV0cyBvbmx5KVxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQdWJsaWMnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBFQ1MgQ2x1c3RlclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0RyYXd2aWRWZXJzZUNsdXN0ZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBjbHVzdGVyTmFtZTogJ2RyYXd2aWR2ZXJzZS1jbHVzdGVyJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciB3b3JsZCBzZXJ2ZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB3b3JsZHNlcnZlclJlcG8gPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ1dvcmxkc2VydmVyUmVwbycsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnZHJhd3ZpZHZlcnNlLXdvcmxkc2VydmVyJyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU2VjdXJpdHkgR3JvdXAgZm9yIHdvcmxkIHNlcnZlciB0YXNrc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHdvcmxkc2VydmVyU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cChcbiAgICAgIHRoaXMsXG4gICAgICAnV29ybGRzZXJ2ZXJTZWN1cml0eUdyb3VwJyxcbiAgICAgIHtcbiAgICAgICAgdnBjLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciB3b3JsZCBzZXJ2ZXIgdGFza3MnLFxuICAgICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBBbGxvdyBpbmJvdW5kIG9uIHBvcnQgNzc3NyAoV2ViU29ja2V0KVxuICAgIHdvcmxkc2VydmVyU2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg3Nzc3KSxcbiAgICAgICdBbGxvdyB3b3JsZCBzZXJ2ZXIgV2ViU29ja2V0IGNvbm5lY3Rpb25zJ1xuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBFQ1MgVGFzayBEZWZpbml0aW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICAnV29ybGRzZXJ2ZXJUYXNrRGVmJyxcbiAgICAgIHtcbiAgICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICAgICAgY3B1OiAyNTYsXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEdyYW50IHRhc2sgcGVybWlzc2lvbiB0byBzdG9wIGl0c2VsZlxuICAgIHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbJ2VjczpTdG9wVGFzayddLFxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gR3JhbnQgdGFzayBwZXJtaXNzaW9uIHRvIHJlYWQvd3JpdGUgYm9vdHN0cmFwIGluIER5bmFtb0RCXG4gICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlKTtcblxuICAgIGNvbnN0IHdvcmxkc2VydmVyQ29udGFpbmVyID0gdGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCd3b3JsZHNlcnZlcicsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkod29ybGRzZXJ2ZXJSZXBvLCAnbGF0ZXN0JyksXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAnd29ybGRzZXJ2ZXInLFxuICAgICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgRERCX1RBQkxFOiB0YWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFdPUkxEX1NUT1JFX01PREU6ICdkeW5hbW9kYicsXG4gICAgICB9LFxuICAgICAgLy8gU2VjcmV0cyBhbmQgb3RoZXIgZW52IHZhcnMgd2lsbCBiZSBwYXNzZWQgdmlhIFJ1blRhc2sgb3ZlcnJpZGVzXG4gICAgfSk7XG5cbiAgICB3b3JsZHNlcnZlckNvbnRhaW5lci5hZGRQb3J0TWFwcGluZ3Moe1xuICAgICAgY29udGFpbmVyUG9ydDogNzc3NyxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhIEZ1bmN0aW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGxhbWJkYUVudiA9IHtcbiAgICAgIFRBQkxFX05BTUU6IHRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIEVDU19DTFVTVEVSX0FSTjogY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgVEFTS19ERUZJTklUSU9OX0FSTjogdGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm4sXG4gICAgICBTVUJORVRTOiB2cGMucHVibGljU3VibmV0cy5tYXAoKHMpID0+IHMuc3VibmV0SWQpLmpvaW4oJywnKSxcbiAgICAgIFNFQ1VSSVRZX0dST1VQOiB3b3JsZHNlcnZlclNlY3VyaXR5R3JvdXAuc2VjdXJpdHlHcm91cElkLFxuICAgICAgSldUX1NFQ1JFVDogand0U2VjcmV0LnNlY3JldFZhbHVlLnVuc2FmZVVud3JhcCgpLCAvLyBJbiBwcm9kdWN0aW9uLCB1c2UgZnJvbVNlY3JldHNNYW5hZ2VyXG4gICAgfTtcblxuICAgIGNvbnN0IGNvbm5lY3RIYW5kbGVyID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQ29ubmVjdEhhbmRsZXInLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnLi4vZGlzdC9sYW1iZGFzJyksXG4gICAgICBoYW5kbGVyOiAnY29ubmVjdC5oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OiBsYW1iZGFFbnYsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgfSk7XG5cbiAgICBjb25zdCBkaXNjb25uZWN0SGFuZGxlciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0Rpc2Nvbm5lY3RIYW5kbGVyJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJy4uL2Rpc3QvbGFtYmRhcycpLFxuICAgICAgaGFuZGxlcjogJ2Rpc2Nvbm5lY3QuaGFuZGxlcicsXG4gICAgICBlbnZpcm9ubWVudDogbGFtYmRhRW52LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdEhhbmRsZXIgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdEZWZhdWx0SGFuZGxlcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuLi9kaXN0L2xhbWJkYXMnKSxcbiAgICAgIGhhbmRsZXI6ICdkZWZhdWx0LmhhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6IGxhbWJkYUVudixcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG1lc3NhZ2VIYW5kbGVyID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnTWVzc2FnZUhhbmRsZXInLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnLi4vZGlzdC9sYW1iZGFzJyksXG4gICAgICBoYW5kbGVyOiAnbWVzc2FnZS5oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OiBsYW1iZGFFbnYsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMDApLCAvLyBMb25nIHRpbWVvdXQgZm9yIHRhc2sgbGF1bmNoXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBwZXJtaXNzaW9uc1xuICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShjb25uZWN0SGFuZGxlcik7XG4gICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGRpc2Nvbm5lY3RIYW5kbGVyKTtcbiAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEoZGVmYXVsdEhhbmRsZXIpO1xuICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShtZXNzYWdlSGFuZGxlcik7XG5cbiAgICBqd3RTZWNyZXQuZ3JhbnRSZWFkKG1lc3NhZ2VIYW5kbGVyKTtcblxuICAgIC8vIEdyYW50IEVDUyBwZXJtaXNzaW9ucyB0byBtZXNzYWdlIGhhbmRsZXJcbiAgICBtZXNzYWdlSGFuZGxlci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnZWNzOlJ1blRhc2snLFxuICAgICAgICAgICdlY3M6RGVzY3JpYmVUYXNrcycsXG4gICAgICAgICAgJ2VjMjpEZXNjcmliZU5ldHdvcmtJbnRlcmZhY2VzJyxcbiAgICAgICAgICAnaWFtOlBhc3NSb2xlJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFdlYlNvY2tldCBBUElcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB3ZWJTb2NrZXRBcGkgPSBuZXcgYXBpZ2F0ZXdheXYyLldlYlNvY2tldEFwaSh0aGlzLCAnRHJhd3ZpZFZlcnNlV3NBcGknLCB7XG4gICAgICBhcGlOYW1lOiAnZHJhd3ZpZHZlcnNlLWxvYmJ5JyxcbiAgICAgIGNvbm5lY3RSb3V0ZU9wdGlvbnM6IHtcbiAgICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnYXRld2F5djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgICAgJ0Nvbm5lY3RJbnRlZ3JhdGlvbicsXG4gICAgICAgICAgY29ubmVjdEhhbmRsZXJcbiAgICAgICAgKSxcbiAgICAgIH0sXG4gICAgICBkaXNjb25uZWN0Um91dGVPcHRpb25zOiB7XG4gICAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ2F0ZXdheXYySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICAgICdEaXNjb25uZWN0SW50ZWdyYXRpb24nLFxuICAgICAgICAgIGRpc2Nvbm5lY3RIYW5kbGVyXG4gICAgICAgICksXG4gICAgICB9LFxuICAgICAgZGVmYXVsdFJvdXRlT3B0aW9uczoge1xuICAgICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWdhdGV3YXl2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgICAnRGVmYXVsdEludGVncmF0aW9uJyxcbiAgICAgICAgICBkZWZhdWx0SGFuZGxlclxuICAgICAgICApLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBtZXNzYWdlIHJvdXRlc1xuICAgIHdlYlNvY2tldEFwaS5hZGRSb3V0ZSgnY3JlYXRlV29ybGQnLCB7XG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWdhdGV3YXl2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgJ0NyZWF0ZVdvcmxkSW50ZWdyYXRpb24nLFxuICAgICAgICBtZXNzYWdlSGFuZGxlclxuICAgICAgKSxcbiAgICB9KTtcblxuICAgIHdlYlNvY2tldEFwaS5hZGRSb3V0ZSgnam9pbldvcmxkJywge1xuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnYXRld2F5djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgICdKb2luV29ybGRJbnRlZ3JhdGlvbicsXG4gICAgICAgIG1lc3NhZ2VIYW5kbGVyXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgd2ViU29ja2V0QXBpLmFkZFJvdXRlKCdsZWF2ZVdvcmxkJywge1xuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnYXRld2F5djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgICdMZWF2ZVdvcmxkSW50ZWdyYXRpb24nLFxuICAgICAgICBtZXNzYWdlSGFuZGxlclxuICAgICAgKSxcbiAgICB9KTtcblxuICAgIHdlYlNvY2tldEFwaS5hZGRSb3V0ZSgncGluZycsIHtcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ2F0ZXdheXYySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICAnUGluZ0ludGVncmF0aW9uJyxcbiAgICAgICAgZGVmYXVsdEhhbmRsZXJcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnYXRld2F5djIuV2ViU29ja2V0U3RhZ2UodGhpcywgJ1Byb2RTdGFnZScsIHtcbiAgICAgIHdlYlNvY2tldEFwaSxcbiAgICAgIHN0YWdlTmFtZTogJ3Byb2QnLFxuICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IEFQSSBHYXRld2F5IGludm9rZSBwZXJtaXNzaW9ucyB0byBsYW1iZGFzXG4gICAgY29uc3QgYXBpR2F0ZXdheU1hbmFnZW1lbnRFbmRwb2ludCA9IGBodHRwczovLyR7d2ViU29ja2V0QXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7c3RhZ2Uuc3RhZ2VOYW1lfWA7XG5cbiAgICBbY29ubmVjdEhhbmRsZXIsIGRpc2Nvbm5lY3RIYW5kbGVyLCBkZWZhdWx0SGFuZGxlciwgbWVzc2FnZUhhbmRsZXJdLmZvckVhY2goKGZuKSA9PiB7XG4gICAgICBmbi5hZGRFbnZpcm9ubWVudCgnV0VCU09DS0VUX0VORFBPSU5UJywgYXBpR2F0ZXdheU1hbmFnZW1lbnRFbmRwb2ludCk7XG5cbiAgICAgIGZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFsnZXhlY3V0ZS1hcGk6TWFuYWdlQ29ubmVjdGlvbnMnXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgIGBhcm46YXdzOmV4ZWN1dGUtYXBpOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fToke3dlYlNvY2tldEFwaS5hcGlJZH0vJHtzdGFnZS5zdGFnZU5hbWV9LypgLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdXZWJTb2NrZXRBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogc3RhZ2UudXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdXZWJTb2NrZXQgQVBJIFVSTCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGRiVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgdGFibGUgbmFtZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3RlckFybicsIHtcbiAgICAgIHZhbHVlOiBjbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIEFSTicsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza0RlZmluaXRpb25Bcm4nLCB7XG4gICAgICB2YWx1ZTogdGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gQVJOJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdXb3JsZHNlcnZlclJlcG9VcmknLCB7XG4gICAgICB2YWx1ZTogd29ybGRzZXJ2ZXJSZXBvLnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUiByZXBvc2l0b3J5IFVSSSBmb3Igd29ybGQgc2VydmVyJyxcbiAgICB9KTtcbiAgfVxufVxuIl19