import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { randomBytes } from 'crypto';

export class MatchmakerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
    const worldserverSecurityGroup = new ec2.SecurityGroup(
      this,
      'WorldserverSecurityGroup',
      {
        vpc,
        description: 'Security group for world server tasks',
        allowAllOutbound: true,
      }
    );

    // Allow inbound on port 7777 (WebSocket)
    worldserverSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(7777),
      'Allow world server WebSocket connections'
    );

    // ========================================================================
    // ECS Task Definition
    // ========================================================================
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'WorldserverTaskDef',
      {
        memoryLimitMiB: 512,
        cpu: 256,
      }
    );

    // Grant task permission to stop itself
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:StopTask'],
        resources: ['*'],
      })
    );

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
    messageHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:RunTask',
          'ecs:DescribeTasks',
          'ec2:DescribeNetworkInterfaces',
          'iam:PassRole',
        ],
        resources: ['*'],
      })
    );

    // ========================================================================
    // WebSocket API
    // ========================================================================
    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'DrawvidVerseWsApi', {
      apiName: 'drawvidverse-lobby',
      connectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'ConnectIntegration',
          connectHandler
        ),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DisconnectIntegration',
          disconnectHandler
        ),
      },
      defaultRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DefaultIntegration',
          defaultHandler
        ),
      },
    });

    // Add message routes
    webSocketApi.addRoute('createWorld', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'CreateWorldIntegration',
        messageHandler
      ),
    });

    webSocketApi.addRoute('joinWorld', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'JoinWorldIntegration',
        messageHandler
      ),
    });

    webSocketApi.addRoute('leaveWorld', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'LeaveWorldIntegration',
        messageHandler
      ),
    });

    webSocketApi.addRoute('ping', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'PingIntegration',
        defaultHandler
      ),
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

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['execute-api:ManageConnections'],
          resources: [
            `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${stage.stageName}/*`,
          ],
        })
      );
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
